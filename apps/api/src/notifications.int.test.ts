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
import Redis from "ioredis";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";
import {
  assertMailhogReachable,
  clearMailbox,
  inbox as mailbox,
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
const { listNotifications, listTemplates, updateTemplate, notify } =
  await import("./modules/notifications/index.js");
const { tenantMigrations } = await import("./core/db/migrations/tenantMigrations.js");
const { cancelAppointment } = await import("./modules/appointments/index.js");
const { closeTaskQueue } = await import("./core/events/taskQueue.js");

const SLUG = "test-notify-apollo";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "notify-int-test" })));

let tenant: { id: string; slug: string; databaseName: string };
let connection: Awaited<ReturnType<typeof getTenantConnection>>;
let token = "";
let doctorToken = "";
let doctorId = "";
let patientId = "";
let patientNoEmailId = "";
let clinicDay: Date;

function auth(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${token}`);
}

/** The same request, signed as the DOCTOR — the person the order messages are addressed to. */
function asDoctor(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${doctorToken}`);
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
      // The doctor signs in too. An inbox suite with one identity cannot tell "scoped to me"
      // apart from "returns everything" — both look identical from a single account.
      await setPassword(doctor.id, PASSWORD, { mustChangePassword: false });
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

  const docLogin = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email: "doc@notify.test", password: PASSWORD });
  doctorToken = docLogin.body.data.accessToken as string;

  /**
   * The day every slot in this file is booked on: the Monday of NEXT week, never the nearest one.
   *
   * MONDAY because that is the only weekday the doctor's schedule below opens (`weekday: 1`), so
   * the fixture has no choice about which day of the week it books.
   *
   * NEXT WEEK because of the reminder rule. `scheduleReminder` deliberately declines to enqueue
   * anything less than 24 hours out — the confirmation the patient just received IS the reminder —
   * so a slot inside that window makes the two queue assertions below unprovable rather than
   * false. The NEAREST Monday is inside it whenever the suite runs late on a Sunday: on
   * 2026-08-23 at 12:59 IST the nearest Monday was the next day, the 12:30 slot was 22 h 31 m
   * away, and both tests went red with no product code having changed.
   *
   * The extra week is what makes this independent of the day it is run. Worst case is a Sunday
   * one second before midnight — still 7 days 9 hours to the earliest slot — and best case is a
   * Monday just after it, at 14 days. The margin never falls below a week, so no hour of no day
   * puts a booking inside the reminder window. `the fixture books outside the reminder window`
   * below asserts all of that rather than trusting this comment.
   */
  clinicDay = new Date();
  clinicDay.setDate(clinicDay.getDate() + ((8 - clinicDay.getDay()) % 7 || 7) + 7);
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
  // The task queue holds its OWN ioredis connection, separate from the cache's — see taskQueue.ts.
  await closeTaskQueue();
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

/**
 * THE ASSERTION WHOSE ABSENCE HID A FOUR-MONTH-OLD BUG.
 *
 * Everything above dispatches `appointment.reminder` BY HAND. That proves the handler decides
 * correctly — and says nothing whatever about whether a booking ever schedules the job that would
 * call it. It did not: `jobId` read `reminder:${tenantId}:${appointmentId}`, BullMQ rejects a
 * custom id containing a colon, and `add()` threw inside a consumer where a throw is
 * indistinguishable from an ordinary retry. Every test in this file passed for four months while
 * not one day-before reminder was ever scheduled in production.
 *
 * So this one asserts on REDIS, which is the only witness that cannot be satisfied by a function
 * having been called. `taskQueue.ts` now also refuses a colon up front (`taskQueue.test.ts`), but
 * that guard only fires for a mistake somebody makes later — this is what proves the feature works
 * today, end to end, through the real queue.
 */
describe("booking actually SCHEDULES the reminder — asserted on the queue, not on a call", () => {
  const redis = new Redis(testRedisUrl("notifications"));

  afterAll(() => {
    redis.disconnect();
  });

  /**
   * THE FIXTURE, CHECKED BEFORE THE FEATURE.
   *
   * Both assertions after this one are unprovable if the appointment sits inside the reminder
   * window, because the product is RIGHT to schedule nothing there — so a fixture that drifts into
   * it reports a product regression that has not happened. That is what it did on Sunday
   * 2026-08-23. Three claims, each failing for a different and legible reason:
   *
   *   the weekday — the doctor's schedule opens on Mondays only, so a booking on any other day is
   *                 refused before any of this is reached;
   *   the offset  — 8 to 14 days, which is the nearest Monday plus a week. A revert to the nearest
   *                 Monday gives 1 to 7 and fails here on EVERY day, not on one in seven;
   *   the window  — the earliest slot the file books, measured against the rule it must clear.
   */
  it("the fixture books outside the reminder window, whatever day the suite runs", () => {
    const earliest = slotAt(9, 0);
    const midnightToday = new Date();
    midnightToday.setHours(0, 0, 0, 0);
    const daysAhead = Math.round((clinicDay.getTime() - midnightToday.getTime()) / 86_400_000);

    expect(earliest.getDay()).toBe(1);
    expect(daysAhead).toBeGreaterThanOrEqual(8);
    expect(daysAhead).toBeLessThanOrEqual(14);
    // `REMINDER_LEAD_MS` in appointment.consumers.ts is 24 h. The floor here is the whole week the
    // fixture promises, so this fails on a fixture that drifted and not on a rule that changed.
    expect(earliest.getTime() - Date.now()).toBeGreaterThan(7 * 86_400_000);
  });

  it("puts a real, delayed job on the notifications queue that BullMQ accepted", async () => {
    const { appointmentId, event } = await book(slotAt(12, 30));

    await asTenant(() => dispatchEventInline(event));

    // The key BullMQ builds is `bull:<queue>:<jobId>`. Its existence is the whole claim: the id
    // was accepted, the job is stored, and a worker will pick it up when the delay elapses.
    const key = `bull:notifications:reminder-${tenant.id}-${appointmentId}`;
    expect(await redis.exists(key)).toBe(1);

    // And it is DELAYED, not waiting — a reminder that fires immediately is a reminder sent a week
    // early, which the handler's re-read would not save us from.
    const delay = Number(await redis.hget(key, "delay"));
    expect(delay).toBeGreaterThan(0);
  });

  /**
   * The same at-least-once redelivery the confirmation is protected from, one layer down. Here the
   * defence is BullMQ's own refusal of a duplicate job id rather than our dedupe key — which only
   * works while the id is deterministic, so this is what pins that it stays so.
   */
  it("redelivering the booking event does not queue a second reminder", async () => {
    const { appointmentId, event } = await book(slotAt(12, 45));

    await asTenant(() => dispatchEventInline(event));
    await asTenant(() => dispatchEventInline(event));

    const jobs = await redis.keys(`bull:notifications:reminder-${tenant.id}-${appointmentId}*`);
    expect(jobs).toHaveLength(1);
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

  /**
   * ── THE SITE A MESSAGE WAS RAISED AT ─────────────────────────────────────
   * Notifications have carried a `branchId` since Multi-Branch Phase 1 — `deliveryBranchId()`
   * stamps it on the way in. The READ mapper dropped it, so the record knew which hospital site
   * it belonged to and no caller could find out. The api-client, meanwhile, declared the field:
   * a promise the server never kept, undetectable until the two could be compared.
   *
   * A single-branch hospital still has a Main Branch, so this holds here and is not a
   * multi-branch-only property.
   */
  it("a notification says which site it was raised at", async () => {
    const { appointmentId, event } = await book(slotAt(12, 15));
    await asTenant(() => dispatchEventInline(event));
    await waitForMail(1);

    const res = await auth(request(app).get("/api/v1/notifications?limit=20")).expect(200);
    const rows = res.body.data as { dedupeKey: string; branchId?: string }[];
    const confirmation = rows.find(
      (r) => r.dedupeKey === `appointment.confirmation:${appointmentId}`,
    );

    expect(confirmation).toBeDefined();
    expect(confirmation?.branchId).toEqual(expect.any(String));

    // Not asserted of EVERY row, and the exception is real rather than a weakening: a message
    // raised outside a request — a job, a test calling `notify()` directly — has no active branch
    // to stamp, and `deliveryBranchId()` fails SOFT there on purpose. A critical-result alert must
    // never go unsent because nobody had picked a site.
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

/**
 * ── THE INBOX ────────────────────────────────────────────────────────────────
 *
 * WHAT DEFECT WOULD THIS CATCH?
 *
 * The ledger has been able to record a message addressed to a named user since Phase 1, and until
 * now no user could read one. The alert with the most at stake in the product — a critical result,
 * sent inline so it beats the outbox — rendered on `email`, and `email.isEnabled()` is
 * `NOTIFY_EMAIL_ENABLED && SMTP_HOST`. On a deployment with no SMTP host, which is the default,
 * that alert was recorded `suppressed` and reached nobody. The mechanism was faultless and the
 * last hop did not exist.
 *
 * These tests pin the hop. Specifically they would catch: an inbox that returns the hospital's
 * mail rather than the caller's (the failure that looks completely normal until two doctors
 * compare screens); a `recipientId` parameter creeping back in, which is how a self-scoped route
 * becomes a directory; a forged id marking somebody else's alert as read; a re-read rewriting the
 * timestamp that says how long a critical value sat unopened; and an inbox that lists messages
 * the system recorded as never sent.
 */
describe("a person can read the messages addressed to them", () => {
  /** Sends one real message to a user through the real door, and returns its ledger row. */
  async function sendTo(
    userId: string,
    address: string | undefined,
    key: string,
    dedupe: string,
  ): Promise<string> {
    await asTenant(() =>
      notify({
        templateKey: key,
        recipient: { ...(address ? { address } : {}), name: "Dr Rao", type: "user", id: userId },
        data: {
          doctorName: "Dr Rao",
          patientName: "Meera Nair",
          uhid: "UH-1",
          testName: "Serum Potassium",
          result: "K 7.2 mmol/L",
          hospital: "Apollo Notify",
        },
        dedupeKey: dedupe,
      }),
    );

    const { items } = await asTenant(() =>
      listNotifications({ recipientId: userId, limit: 50, skip: 0 }),
    );
    const row = items.find((n) => n.dedupeKey === dedupe);
    expect(row, `nothing was recorded for ${dedupe}`).toBeTruthy();
    return row!.id;
  }

  it("delivers a released result to the doctor who ordered it, and to nobody else", async () => {
    await sendTo(
      doctorId,
      "doc@notify.test",
      "order.result.released",
      `inbox:released:${Date.now()}`,
    );

    const mine = await asDoctor(request(app).get("/api/v1/notifications/me")).expect(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data[0].body).toContain("Serum Potassium");

    /**
     * The administrator is not the recipient. This is the assertion that separates "scoped to the
     * caller" from "returns everything" — and TENANT_ADMIN is the right account to prove it with,
     * because it holds every permission in the catalogue and still must see none of this.
     */
    const theirs = await auth(request(app).get("/api/v1/notifications/me")).expect(200);
    expect(theirs.body.data.some((m: { body: string }) => m.body.includes("Serum Potassium"))).toBe(
      false,
    );
  });

  it("needs no permission — every role has an inbox", async () => {
    // The doctor holds neither `notification:manage` nor anything resembling it, and the ledger
    // route below proves that in the same breath.
    await asDoctor(request(app).get("/api/v1/notifications/me")).expect(200);
    await asDoctor(request(app).get("/api/v1/notifications")).expect(403);
  });

  it("will not take a recipient from the caller", async () => {
    // `.strict()`, so this is a 400 and not a silently ignored parameter. An ignored one would be
    // worse: the caller believes they asked for somebody else's mail and got an empty answer.
    await asDoctor(request(app).get(`/api/v1/notifications/me?recipientId=${doctorId}`)).expect(
      400,
    );
  });

  it("counts what is unread, and stops counting it once it is opened", async () => {
    const id = await sendTo(
      doctorId,
      "doc@notify.test",
      "order.critical",
      `inbox:crit:${Date.now()}`,
    );

    const before = await asDoctor(
      request(app).get("/api/v1/notifications/me?unread=true&limit=5"),
    ).expect(200);
    const unreadBefore = before.body.meta.total as number;
    expect(unreadBefore).toBeGreaterThan(0);
    expect(before.body.data.every((m: { readAt?: string }) => m.readAt === undefined)).toBe(true);

    const opened = await asDoctor(request(app).post(`/api/v1/notifications/${id}/read`)).expect(
      200,
    );
    expect(opened.body.data.readAt).toBeTruthy();

    const after = await asDoctor(
      request(app).get("/api/v1/notifications/me?unread=true&limit=5"),
    ).expect(200);
    expect(after.body.meta.total).toBe(unreadBefore - 1);

    // Still in the inbox — opening a message files it, it does not delete it.
    const all = await asDoctor(request(app).get("/api/v1/notifications/me")).expect(200);
    expect(all.body.data.some((m: { id: string }) => m.id === id)).toBe(true);
  });

  /**
   * `?unread=false` must mean "everything", not "unread only".
   *
   * The obvious spelling of this parameter is `z.coerce.boolean()`, which turns every non-empty
   * string true — so the honest-looking request `?unread=false` would return the exact opposite of
   * what it asks for, with no error. The schema uses a two-value enum instead; this is the test
   * that says why.
   */
  it("reads `unread=false` as the caller meant it", async () => {
    const id = await sendTo(
      doctorId,
      "doc@notify.test",
      "order.result.released",
      `inbox:false:${Date.now()}`,
    );
    await asDoctor(request(app).post(`/api/v1/notifications/${id}/read`)).expect(200);

    const all = await asDoctor(request(app).get("/api/v1/notifications/me?unread=false")).expect(
      200,
    );
    expect(all.body.data.some((m: { id: string }) => m.id === id)).toBe(true);

    await asDoctor(request(app).get("/api/v1/notifications/me?unread=maybe")).expect(400);
  });

  /**
   * A critical alert that sat unopened for forty minutes is a different event from one read
   * immediately, and `readAt` is the only evidence of which happened. A second click must not
   * quietly move it forward.
   */
  it("keeps the time a message was FIRST opened", async () => {
    const id = await sendTo(
      doctorId,
      "doc@notify.test",
      "order.critical",
      `inbox:first:${Date.now()}`,
    );

    const first = await asDoctor(request(app).post(`/api/v1/notifications/${id}/read`)).expect(200);
    await new Promise((r) => setTimeout(r, 25));
    const second = await asDoctor(request(app).post(`/api/v1/notifications/${id}/read`)).expect(
      200,
    );

    expect(second.body.data.readAt).toBe(first.body.data.readAt);
  });

  it("refuses to open somebody else's message, and does not mark it read", async () => {
    const id = await sendTo(
      doctorId,
      "doc@notify.test",
      "order.critical",
      `inbox:theirs:${Date.now()}`,
    );

    // The administrator holds every permission there is. It makes no difference: the recipient is
    // in the WHERE clause, not in a check that a privileged caller could pass.
    await auth(request(app).post(`/api/v1/notifications/${id}/read`)).expect(404);

    const still = await asDoctor(
      request(app).get("/api/v1/notifications/me?unread=true&limit=100"),
    );
    expect(still.body.data.some((m: { id: string }) => m.id === id)).toBe(true);
  });

  it("answers 404 for an id that does not exist, and 400 for one that could not", async () => {
    await asDoctor(request(app).post("/api/v1/notifications/64b7f0000000000000000009/read")).expect(
      404,
    );
    await asDoctor(request(app).post("/api/v1/notifications/not-an-id/read")).expect(400);
  });

  /**
   * A message the system recorded as NOT sent must not appear in the inbox. Listing it would
   * deliver, after the fact, something the ledger already says was withheld — and it would make
   * the read receipt meaningless. The administrator's ledger is where suppressed messages belong,
   * because they are that person's problem to fix.
   */
  it("does not show the recipient a message that was never sent", async () => {
    await asTenant(() => updateTemplate("order.result.released", { enabled: false }));
    const dedupe = `inbox:suppressed:${Date.now()}`;

    try {
      const id = await sendTo(doctorId, "doc@notify.test", "order.result.released", dedupe);

      const mine = await asDoctor(request(app).get("/api/v1/notifications/me?limit=100")).expect(
        200,
      );
      expect(mine.body.data.some((m: { id: string }) => m.id === id)).toBe(false);

      // It is not lost — it is where an administrator can see it and act on the cause.
      const ledger = await auth(
        request(app).get("/api/v1/notifications?status=suppressed&limit=100"),
      ).expect(200);
      expect(ledger.body.data.some((n: { id: string }) => n.id === id)).toBe(true);

      // And it cannot be opened, which would put a read receipt on an unsent message.
      await asDoctor(request(app).post(`/api/v1/notifications/${id}/read`)).expect(404);
    } finally {
      await asTenant(() => updateTemplate("order.result.released", { enabled: true }));
    }
  });

  it("shows the newest message first", async () => {
    const stamp = Date.now();
    await sendTo(doctorId, "doc@notify.test", "order.result.released", `inbox:order-a:${stamp}`);
    await new Promise((r) => setTimeout(r, 15));
    await sendTo(doctorId, "doc@notify.test", "order.critical", `inbox:order-b:${stamp}`);

    const mine = await asDoctor(request(app).get("/api/v1/notifications/me?limit=2")).expect(200);
    const times = (mine.body.data as { createdAt: string }[]).map((m) => Date.parse(m.createdAt));
    expect(times[0]).toBeGreaterThanOrEqual(times[1]!);
  });

  /**
   * The inbox is reached with no permission at all, so its SHAPE is part of its safety argument.
   * The ledger record carries an address, a dedupe key, a retry count and an SMTP error string;
   * none of that is the reader's business, and a field added to the ledger contract must not
   * arrive here by inheritance.
   */
  it("returns the reader's message, not the operator's delivery record", async () => {
    await sendTo(doctorId, "doc@notify.test", "order.critical", `inbox:shape:${Date.now()}`);

    const mine = await asDoctor(request(app).get("/api/v1/notifications/me?limit=1")).expect(200);
    const message = mine.body.data[0] as Record<string, unknown>;

    // Every key present must be one the inbox contract declares. Asserted this way round rather
    // than as a fixed list, because `branchId` and `readAt` are legitimately absent here and a
    // list would go red for the wrong reason the day a message carries one.
    const ALLOWED = ["id", "templateKey", "subject", "body", "branchId", "readAt", "createdAt"];
    for (const key of Object.keys(message)) {
      expect(ALLOWED, `the inbox returned an undeclared field \`${key}\``).toContain(key);
    }

    // And the ledger's operational fields by name — these are the ones that would ride along if
    // anybody went back to returning the full record and trusted `responds()` to trim it.
    for (const leaked of ["to", "dedupeKey", "attempts", "error", "status", "recipientId"]) {
      expect(message, `the inbox exposed \`${leaked}\``).not.toHaveProperty(leaked);
    }
  });
});

/**
 * ── THE CHANNEL A STAFF ALERT ACTUALLY TRAVELS ON ────────────────────────────
 *
 * WHAT DEFECT WOULD THIS CATCH?
 *
 * The one this milestone exists to close, and its mirror image.
 *
 * The defect: `order.critical` shipped on `email`, and `email.isEnabled()` is
 * `NOTIFY_EMAIL_ENABLED && SMTP_HOST`. On a deployment with no mail server — the default — the
 * most urgent message in the product was recorded `suppressed` and reached nobody, while every
 * mechanism around it worked perfectly. These tests fail if either staff alert goes back to a
 * channel that can be switched off.
 *
 * The mirror image, which a blanket flip would cause: moving the PATIENT messages to `inapp` as
 * well. A patient has no login and no inbox, so an in-app appointment reminder is a message
 * addressed to somebody who can never open it — the same failure, pointing the other way, and
 * silent because the ledger would cheerfully record every one of them as `sent`.
 *
 * `password.reset` is the one staff message that must stay on email: a person who cannot sign in
 * cannot read an in-app inbox.
 */
describe("a staff alert does not depend on a mail server", () => {
  it("routes the two order alerts in-app, and everything else out by mail", async () => {
    const templates = await asTenant(() => listTemplates());
    const channelOf = (key: string) => templates.find((t) => t.key === key)?.channel;

    expect(channelOf("order.critical")).toBe("inapp");
    expect(channelOf("order.result.released")).toBe("inapp");

    // A patient cannot open an in-app inbox. Nor can a member of staff who has lost their password.
    expect(channelOf("patient.welcome")).toBe("email");
    expect(channelOf("appointment.confirmation")).toBe("email");
    expect(channelOf("appointment.reminder")).toBe("email");
    expect(channelOf("appointment.cancellation")).toBe("email");
    expect(channelOf("password.reset")).toBe("email");
  });

  /**
   * The real proof, and it is about what did NOT happen: the alert is delivered, it is in the
   * doctor's inbox, and the mail server — which is running and reachable in this suite — was never
   * asked for anything. A hospital with no SMTP at all gets the identical outcome, because the
   * in-app channel has no transport to be missing.
   */
  it("delivers a critical result with the mail server untouched", async () => {
    await clearMailbox();
    const dedupe = `channel:crit:${Date.now()}`;

    const outcome = await asTenant(() =>
      notify({
        templateKey: "order.critical",
        recipient: { address: "doc@notify.test", name: "Dr Rao", type: "user", id: doctorId },
        data: {
          doctorName: "Dr Rao",
          patientName: "Meera Nair",
          uhid: "UH-1",
          testName: "Serum Potassium",
          result: "K 7.2 mmol/L",
          hospital: "Apollo Notify",
        },
        dedupeKey: dedupe,
      }),
    );
    expect(outcome).toBe("sent");

    const { items } = await asTenant(() =>
      listNotifications({ recipientId: doctorId, limit: 50, skip: 0 }),
    );
    const row = items.find((n) => n.dedupeKey === dedupe);
    expect(row?.channel).toBe("inapp");
    expect(row?.status).toBe("sent");

    // Nothing left by SMTP. This is the assertion that would have caught the original defect from
    // the other side: on the old template this row's delivery depended entirely on a mail server.
    expect(await mailbox()).toHaveLength(0);

    // And it is readable by the person it names, carrying the value that makes it worth reading.
    const mine = await asDoctor(request(app).get("/api/v1/notifications/me?limit=5")).expect(200);
    const message = (mine.body.data as { id: string; body: string }[]).find(
      (m) => m.id === row!.id,
    );
    expect(message?.body).toContain("K 7.2 mmol/L");
  });

  /**
   * ── THE HOSPITAL THAT WAS PROVISIONED BEFORE THIS RELEASE ───────────────────
   * `seedNotificationTemplates` writes `$setOnInsert`, so changing a shipped default reaches NEW
   * tenants only. Without migration 0051 every existing hospital would have kept `order.critical`
   * on the switched-off channel, and the fix would have looked applied while changing nothing for
   * every current customer — the same trap the lab catalogue fell into a milestone ago.
   *
   * This puts a template back the way an older hospital's database holds it and runs the
   * migration over it.
   */
  it("re-points a hospital whose templates predate the change", async () => {
    const templates = connection.collection("notificationTemplates");
    const before = await templates.findOne({ key: "order.critical" });
    expect(before, "the template must exist for this to mean anything").toBeTruthy();

    try {
      // An older hospital, which had also rewritten the wording — that must survive.
      await templates.updateOne(
        { key: "order.critical" },
        { $set: { channel: "email", isDefault: false, subject: "Our own words" } },
      );

      const migration = tenantMigrations.find((m) => m.id === "0051-staff-alerts-in-app");
      expect(migration, "migration 0051 is missing").toBeTruthy();
      await migration!.up(connection);

      const after = await templates.findOne({ key: "order.critical" });
      expect(after?.channel).toBe("inapp");
      // One field moved. The hospital's words, and the fact that they are theirs, are untouched.
      expect(after?.subject).toBe("Our own words");
      expect(after?.isDefault).toBe(false);

      // Idempotent — a second run has nothing left to match.
      await migration!.up(connection);
      expect((await templates.findOne({ key: "order.critical" }))?.channel).toBe("inapp");
    } finally {
      await templates.updateOne(
        { key: "order.critical" },
        {
          $set: {
            channel: before!.channel,
            isDefault: before!.isDefault,
            subject: before!.subject,
          },
        },
      );
    }
  });
});
