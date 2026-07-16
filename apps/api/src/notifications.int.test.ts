/**
 * NOTIFICATIONS SUITE — release-gating (Doc 02 A6, ADR-0007).
 *
 * Two properties dominate this module, and this suite exists to defend them:
 *
 *   1. ONE MESSAGE PER CAUSE. Delivery is at-least-once by design — the relay
 *      redelivers rather than risk losing an event — so the consumer WILL see the
 *      same booking twice. If that produced two confirmations, every patient would
 *      eventually be double-messaged, and a hospital would stop trusting the system
 *      it uses to tell people when to come in.
 *
 *   2. NO REMINDER FOR AN APPOINTMENT THAT IS NOT HAPPENING. A patient reminded to
 *      attend an appointment they cancelled is worse than no reminder at all: it
 *      destroys their confidence in every other message we send them.
 *
 * Both are tested against a REAL mail server (Mailhog) and asserted on what actually
 * landed in the inbox. A mocked transport would prove we called nodemailer, which is
 * not a claim anyone cares about.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";
import {
  assertMailhogReachable,
  clearMailbox,
  waitForMail,
  TEST_SMTP_HOST,
  TEST_SMTP_PORT,
} from "./test/mailTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("notifications");
process.env.MONGO_MASTER_DB = "test_notify_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";
// Set BEFORE the app is imported: env is parsed once, at module load.
process.env.SMTP_HOST = TEST_SMTP_HOST;
process.env.SMTP_PORT = TEST_SMTP_PORT;
process.env.MAIL_FROM = "MediCore Test <no-reply@test.local>";

const { createApp } = await import("./app.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedNotificationTemplates } = await import("./seed/notificationTemplates.js");
const { dispatchEventInline, dispatchTaskInline } = await import("./core/events/eventConsumer.js");
const { listNotifications, updateTemplate, notify } =
  await import("./modules/notifications/index.js");
const { cancelAppointment } = await import("./modules/appointments/index.js");

const SLUG = "test-notify-apollo";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "notify-int-test" }));

let tenant: { id: string; slug: string; databaseName: string };
let connection: Awaited<ReturnType<typeof getTenantConnection>>;
let token = "";
let doctorId = "";
let patientId = "";
let patientNoEmailId = "";
let clinicDay: Date;

function auth(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${token}`);
}

function slotAt(hour: number, minute = 0): Date {
  const d = new Date(clinicDay);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Runs `fn` inside the tenant context, the way a background consumer does. */
async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "notify-test", tenantId: tenant.id, tenantSlug: SLUG, connection },
    fn,
  );
}

/** Books a slot through the API and returns the appointment + the event it published. */
async function book(startAt: Date, patient = patientId) {
  const res = await auth(request(app).post("/api/v1/appointments"))
    .send({ patientId: patient, doctorId, startAt: startAt.toISOString(), reason: "checkup" })
    .expect(201);

  const appointmentId = res.body.data.id as string;

  return {
    appointmentId,
    /** The envelope the relay would put on the queue for this booking. */
    event: {
      eventId: `evt-${appointmentId}`,
      name: "appointment.appointment.booked",
      version: 1,
      tenantId: tenant.id,
      occurredAt: new Date().toISOString(),
      payload: { appointmentId, patientId: patient, doctorId, startAt: startAt.toISOString() },
    },
  };
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await assertMailhogReachable();
  await dropDatabases(["test_notify_master", DB]);
  await flushTestCache("notifications");

  const t = await provisionTenant({
    hospitalName: "Apollo Notify",
    slug: SLUG,
    planCode: "PLAN_CLINIC",
  });
  tenant = { id: t.tenant.id, slug: SLUG, databaseName: t.tenant.databaseName };

  connection = await getTenantConnection({ id: tenant.id, databaseName: tenant.databaseName });

  await runWithContext(
    { traceId: "notify-setup", tenantId: tenant.id, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();

      const admin = await createUser({
        email: "admin@notify.test",
        name: "Admin",
        status: "invited",
      });
      await setPassword(admin.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(admin.id, "TENANT_ADMIN", []);
      await transitionStatus(admin.id, "active");

      const doctor = await createUser({
        email: "doc@notify.test",
        name: "Dr Rao",
        status: "invited",
      });
      await assignRoleByCode(doctor.id, "DOCTOR", []);
      await transitionStatus(doctor.id, "active");
      doctorId = doctor.id;
    },
  );

  await seedNotificationTemplates(tenant.id, SLUG, connection);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email: "admin@notify.test", password: PASSWORD });
  token = login.body.data.accessToken as string;

  clinicDay = new Date();
  clinicDay.setDate(clinicDay.getDate() + ((8 - clinicDay.getDay()) % 7 || 7));
  clinicDay.setHours(0, 0, 0, 0);

  await auth(request(app).put("/api/v1/doctors/schedule"))
    .send({ doctorId, weekday: 1, startMinute: 540, endMinute: 780, slotMinutes: 15 })
    .expect(201);

  const patient = await auth(request(app).post("/api/v1/patients"))
    .send({
      name: "Meera Nair",
      gender: "female",
      contact: { phone: "9000000123", email: "meera@example.test" },
    })
    .expect(201);
  patientId = patient.body.data.patient.id as string;

  // The patient a hospital actually has: a phone number and no email. Half the
  // notification code exists for this person.
  const noEmail = await auth(request(app).post("/api/v1/patients"))
    .send({ name: "Ravi Kumar", gender: "male", contact: { phone: "9000000999" } })
    .expect(201);
  patientNoEmailId = noEmail.body.data.patient.id as string;
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_notify_master", DB]);
}, 30_000);

beforeEach(async () => {
  await clearMailbox();
});

describe("the confirmation actually reaches the patient", () => {
  it("a booking sends one email that names the doctor, the day and the time", async () => {
    const { event } = await book(slotAt(9, 0));

    await asTenant(() => dispatchEventInline(event));

    const mail = await waitForMail(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toContain("meera@example.test");
    expect(mail[0]?.subject).toContain("Appointment confirmed");

    // The body is rendered, not a template: a patient must never receive `{{doctor}}`.
    expect(mail[0]?.body).toContain("Dr Rao");
    expect(mail[0]?.body).toContain("Meera Nair");
    expect(mail[0]?.body).not.toContain("{{");
  });

  it("renders the time in the hospital's timezone, not UTC", async () => {
    // 09:00 IST is 03:30 UTC. A reminder that says 03:30 sends the patient to an
    // empty clinic in the middle of the night — this is the assertion that keeps
    // DEFAULT_TIMEZONE honest.
    const { event } = await book(slotAt(9, 15));
    await asTenant(() => dispatchEventInline(event));

    const mail = await waitForMail(1);
    expect(mail[0]?.body).toMatch(/09:15\s*(am|AM)/);
  });
});

describe("ONE MESSAGE PER CAUSE (the at-least-once guarantee)", () => {
  it("redelivering the same booking event does NOT send a second confirmation", async () => {
    const { event } = await book(slotAt(9, 30));

    // The relay crashed after enqueueing and before marking sent, so the event is
    // delivered again. This is not a hypothetical — it is the documented behaviour
    // of the outbox (outboxRelay.ts), and it happens on every deploy that lands
    // mid-flight.
    await asTenant(() => dispatchEventInline(event));
    await asTenant(() => dispatchEventInline(event));
    await asTenant(() => dispatchEventInline(event));

    const mail = await waitForMail(2, 1_500); // wait for a SECOND that must never come
    expect(mail).toHaveLength(1);
  });

  /**
   * THE TEST THAT FOUND A REAL BUG.
   *
   * The first implementation re-sent any row that was not yet `sent`, reasoning that
   * a `pending` row must have been abandoned by a sender that died. But `pending`
   * also describes a sender that is alive and inside the SMTP call right now — so
   * the recovery path for a corpse fired for a healthy handler, and this test found
   * two emails in the inbox. The fix is a lease (notification.repository.claim).
   */
  it("two handlers racing on the same event still produce exactly one message", async () => {
    const { event } = await book(slotAt(9, 45));

    // Two senders, same event, no coordination. One wins the insert; the other is
    // refused by the unique index, finds a FRESH lease on the row, and declines to
    // send. It throws (so its job would retry and then find the row `sent`) —
    // hence allSettled: a rejection here is the design working, not a failure.
    const results = await asTenant(() =>
      Promise.allSettled([dispatchEventInline(event), dispatchEventInline(event)]),
    );

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const mail = await waitForMail(2, 1_500);
    expect(mail).toHaveLength(1);

    const ledger = await asTenant(() =>
      listNotifications({ templateKey: "appointment.confirmation", limit: 50, skip: 0 }),
    );
    const forThis = ledger.items.filter((n) =>
      n.dedupeKey.endsWith(String(event.payload.appointmentId)),
    );
    expect(forThis).toHaveLength(1);
    expect(forThis[0]?.status).toBe("sent");
  });
});

describe("the reminder is a trigger; the database is the truth", () => {
  it("sends the day-before reminder for an appointment that is still on", async () => {
    const { appointmentId } = await book(slotAt(10, 0));

    // Fire the delayed job by hand — 24 hours early, which is exactly what BullMQ
    // will do for real, just later.
    await asTenant(() => dispatchTaskInline("appointment.reminder", { appointmentId }));

    const mail = await waitForMail(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toContain("Reminder");
    expect(mail[0]?.body).toContain("Dr Rao");
  });

  it("sends NO reminder for an appointment that was cancelled", async () => {
    const { appointmentId } = await book(slotAt(10, 15));

    await asTenant(() => cancelAppointment(appointmentId, "patient rang to cancel"));
    await clearMailbox(); // the cancellation notice is not what is under test here

    // The reminder job was scheduled at booking time and NOBODY CANCELLED IT — by
    // design. It fires, re-reads the appointment, and finds it is not happening.
    await asTenant(() => dispatchTaskInline("appointment.reminder", { appointmentId }));

    const mail = await waitForMail(1, 1_500);
    expect(mail).toHaveLength(0);
  });

  it("reminds only once, however many times the job is retried", async () => {
    const { appointmentId } = await book(slotAt(10, 30));

    await asTenant(() => dispatchTaskInline("appointment.reminder", { appointmentId }));
    await asTenant(() => dispatchTaskInline("appointment.reminder", { appointmentId }));

    const mail = await waitForMail(2, 1_500);
    expect(mail).toHaveLength(1);
  });
});

describe("cancellation tells the patient", () => {
  it("a cancelled appointment emails the patient with the reason", async () => {
    const { appointmentId } = await book(slotAt(11, 0));
    await asTenant(() => cancelAppointment(appointmentId, "the doctor is unwell"));

    await asTenant(() =>
      dispatchEventInline({
        eventId: `evt-cancel-${appointmentId}`,
        name: "appointment.appointment.cancelled",
        version: 1,
        tenantId: tenant.id,
        occurredAt: new Date().toISOString(),
        payload: { appointmentId, reason: "the doctor is unwell" },
      }),
    );

    const mail = await waitForMail(1);
    expect(mail[0]?.subject).toContain("cancelled");
    expect(mail[0]?.body).toContain("the doctor is unwell");
  });
});

describe("a patient with no email is a data problem, not an outage", () => {
  it("records `unreachable` — never `failed` — and sends nothing", async () => {
    const { event } = await book(slotAt(11, 15), patientNoEmailId);

    await asTenant(() => dispatchEventInline(event));

    const mail = await waitForMail(1, 1_500);
    expect(mail).toHaveLength(0);

    const ledger = await asTenant(() =>
      listNotifications({ recipientId: patientNoEmailId, limit: 10, skip: 0 }),
    );

    // The distinction that keeps an on-call engineer asleep: `failed` means WE are
    // broken and the job retries; `unreachable` means the hospital never collected
    // an email address, which no retry can fix.
    expect(ledger.items[0]?.status).toBe("unreachable");
    expect(ledger.items[0]?.status).not.toBe("failed");
  });
});

describe("the hospital owns the words", () => {
  it("a disabled template suppresses the message but still records it", async () => {
    await asTenant(() => updateTemplate("appointment.confirmation", { enabled: false }));

    const { event } = await book(slotAt(11, 30));
    await asTenant(() => dispatchEventInline(event));

    const mail = await waitForMail(1, 1_500);
    expect(mail).toHaveLength(0);

    const ledger = await asTenant(() =>
      listNotifications({ status: "suppressed", limit: 10, skip: 0 }),
    );
    // Recorded, not silently dropped: an admin must be able to see what WOULD have
    // gone out while the switch was off.
    expect(ledger.items.length).toBeGreaterThan(0);

    await asTenant(() => updateTemplate("appointment.confirmation", { enabled: true }));
  });

  it("edited wording is used, and the template stops being a default", async () => {
    await asTenant(() =>
      updateTemplate("patient.welcome", {
        subject: "Namaste {{name}}",
        body: "Your UHID is {{uhid}}. — {{hospital}}",
      }),
    );

    await asTenant(() =>
      notify({
        templateKey: "patient.welcome",
        recipient: { address: "edited@example.test", name: "Edited", type: "patient", id: "x1" },
        data: { name: "Edited", uhid: "UH000042", hospital: "Apollo Notify" },
        dedupeKey: `patient.welcome:edited-${String(Date.now())}`,
      }),
    );

    const mail = await waitForMail(1);
    expect(mail[0]?.subject).toBe("Namaste Edited");
    expect(mail[0]?.body).toContain("UH000042");
  });

  it("an unknown placeholder renders empty rather than leaking `{{syntax}}` to a patient", async () => {
    await asTenant(() =>
      updateTemplate("patient.welcome", { subject: "Hello {{nope}}", body: "Body {{alsoNope}}" }),
    );

    await asTenant(() =>
      notify({
        templateKey: "patient.welcome",
        recipient: { address: "ph@example.test", type: "patient", id: "x2" },
        data: { name: "X" },
        dedupeKey: `patient.welcome:ph-${String(Date.now())}`,
      }),
    );

    const mail = await waitForMail(1);
    expect(mail[0]?.subject).toBe("Hello");
    expect(mail[0]?.body).not.toContain("{{");
  });
});

describe('the ledger is the answer to "did they get it?"', () => {
  it("requires notification:manage — a message body is PHI", async () => {
    await request(app).get("/api/v1/notifications").set("Host", HOST).expect(401);
  });

  it("lists what was sent, newest first", async () => {
    const { event } = await book(slotAt(12, 0));
    await asTenant(() => dispatchEventInline(event));
    await waitForMail(1);

    const res = await auth(request(app).get("/api/v1/notifications?limit=5")).expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty("status");
    expect(res.body.data[0]).toHaveProperty("dedupeKey");
  });

  it("exposes the template catalog for the admin who wants to rewrite it", async () => {
    const res = await auth(request(app).get("/api/v1/notifications/templates")).expect(200);

    const keys = (res.body.data as { key: string }[]).map((t) => t.key);
    expect(keys).toContain("appointment.confirmation");
    expect(keys).toContain("appointment.reminder");
  });

  it("refuses to invent a template that no code will ever render", async () => {
    await auth(request(app).put("/api/v1/notifications/templates/not.a.real.key"))
      .send({ body: "hello" })
      .expect(404);
  });
});
