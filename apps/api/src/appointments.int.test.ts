/**
 * APPOINTMENTS SUITE — release-gating (Doc 02 E1, STATE_MACHINE_CATALOG §1).
 *
 * One property dominates this module and this suite exists mainly to defend it:
 *
 *     A DOCTOR CANNOT BE IN TWO PLACES AT ONCE.
 *
 * It is guaranteed by a unique partial index, not by a check in the service,
 * because a check cannot win a race: two receptionists both read "10:30 is free"
 * and both write. So the test that matters fires CONCURRENT bookings at the same
 * slot and asserts exactly one survives. A sequential test would pass even if the
 * index were dropped — it would prove nothing, which is the trap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("appointments");
process.env.MONGO_MASTER_DB = "test_appt_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

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
const { canTransition } = await import("./modules/appointments/index.js");

const SLUG = "test-appt-apollo";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "appt-int-test" }));

let tenant: { id: string; slug: string; databaseName: string };
let token = "";
let doctorId = "";
let patientId = "";
/** The Monday after today — always in the future, always a scheduled weekday. */
let clinicDay: Date;

function auth(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${token}`);
}

/** The slot at `hour:minute` local on the clinic day. */
function slotAt(hour: number, minute = 0): Date {
  const d = new Date(clinicDay);
  d.setHours(hour, minute, 0, 0);
  return d;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_appt_master", DB]);
  await flushTestCache("appointments");

  const t = await provisionTenant({
    hospitalName: "Apollo Appt",
    slug: SLUG,
    planCode: "PLAN_CLINIC", // includes module.ops.appointments
  });
  tenant = { id: t.tenant.id, slug: SLUG, databaseName: t.tenant.databaseName };

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });

  await runWithContext(
    { traceId: "appt-setup", tenantId: tenant.id, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();

      const admin = await createUser({
        email: "admin@appt.test",
        name: "Admin",
        status: "invited",
      });
      await setPassword(admin.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(admin.id, "TENANT_ADMIN", []);
      await transitionStatus(admin.id, "active");

      const doctor = await createUser({
        email: "doc@appt.test",
        name: "Dr Rao",
        status: "invited",
      });
      await assignRoleByCode(doctor.id, "DOCTOR", []);
      await transitionStatus(doctor.id, "active");
      doctorId = doctor.id;
    },
  );

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email: "admin@appt.test", password: PASSWORD });
  token = login.body.data.accessToken as string;

  // Next Monday, so the clinic day is always in the future and always a weekday
  // the schedule covers. A test that books "today at 09:00" fails every afternoon.
  clinicDay = new Date();
  clinicDay.setDate(clinicDay.getDate() + ((8 - clinicDay.getDay()) % 7 || 7));
  clinicDay.setHours(0, 0, 0, 0);

  // Dr Rao: Mondays, 09:00–13:00, 15-minute slots → 16 slots.
  await auth(request(app).put("/api/v1/doctors/schedule"))
    .send({ doctorId, weekday: 1, startMinute: 540, endMinute: 780, slotMinutes: 15 })
    .expect(201);

  const patient = await auth(request(app).post("/api/v1/patients"))
    .send({ name: "Appointment Patient", gender: "female", contact: { phone: "9000000123" } })
    .expect(201);
  patientId = patient.body.data.patient.id as string;
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_appt_master", DB]);
}, 30_000);

describe("availability (slots are computed, never stored)", () => {
  it("a 09:00–13:00 session with 15-minute slots yields 16 slots", async () => {
    const res = await auth(
      request(app).get(
        `/api/v1/appointments/availability?doctorId=${doctorId}&date=${clinicDay.toISOString()}`,
      ),
    ).expect(200);

    expect(res.body.data).toHaveLength(16);
  });

  it("a day the doctor does not work has no slots", async () => {
    const sunday = new Date(clinicDay);
    sunday.setDate(sunday.getDate() - 1);

    const res = await auth(
      request(app).get(
        `/api/v1/appointments/availability?doctorId=${doctorId}&date=${sunday.toISOString()}`,
      ),
    ).expect(200);

    expect(res.body.data).toEqual([]);
  });
});

describe("booking", () => {
  it("books a real slot and removes it from availability", async () => {
    const startAt = slotAt(9, 0);

    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: startAt.toISOString(), reason: "fever" })
      .expect(201);

    expect(booked.body.data.status).toBe("requested");

    const after = await auth(
      request(app).get(
        `/api/v1/appointments/availability?doctorId=${doctorId}&date=${clinicDay.toISOString()}`,
      ),
    ).expect(200);

    const starts = (after.body.data as { startAt: string }[]).map((s) => s.startAt);
    expect(starts).not.toContain(startAt.toISOString());
    expect(after.body.data).toHaveLength(15);
  });

  it("refuses a time the doctor has no clinic session for", async () => {
    const res = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: slotAt(3, 47).toISOString() })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("refuses a slot in the past", async () => {
    const past = new Date(clinicDay);
    past.setDate(past.getDate() - 7);
    past.setHours(9, 0, 0, 0);

    await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: past.toISOString() })
      .expect(400);
  });

  /**
   * THE TEST THIS MODULE EXISTS FOR.
   *
   * Ten receptionists, one slot, all at once. Exactly one may win. This is fired
   * concurrently on purpose: run sequentially, it would pass even with the unique
   * index dropped, and would therefore be proving nothing at all.
   */
  it("ten concurrent bookings of ONE slot produce exactly one appointment", async () => {
    const startAt = slotAt(10, 30);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        auth(request(app).post("/api/v1/appointments")).send({
          patientId,
          doctorId,
          startAt: startAt.toISOString(),
        }),
      ),
    );

    const created = attempts.filter((r) => r.status === 201);
    const rejected = attempts.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // And the losers are told how to recover, not merely refused.
    for (const res of rejected) {
      expect(res.body.error.code).toBe("HMS-APT-001");
      expect(Array.isArray(res.body.error.details.alternatives)).toBe(true);
    }
  });

  it("a cancelled appointment RELEASES its slot", async () => {
    const startAt = slotAt(11, 0);

    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: startAt.toISOString() })
      .expect(201);

    await auth(request(app).post(`/api/v1/appointments/${booked.body.data.id}/cancel`))
      .send({ reason: "patient rang to cancel" })
      .expect(200);

    // The slot must be bookable again — otherwise `occupies` leaked and 11:00 is
    // dead forever, with nobody able to explain why.
    await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: startAt.toISOString() })
      .expect(201);
  });
});

describe("lifecycle (STATE_MACHINE_CATALOG §1)", () => {
  it("rejects every transition the catalog does not list", () => {
    // The guard, unit-tested directly: the catalog is the spec and this is its
    // transcription. An illegal edge added by a future refactor dies here.
    expect(canTransition("requested", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "checked_in")).toBe(true);
    expect(canTransition("checked_in", "in_consultation")).toBe(true);
    expect(canTransition("in_consultation", "completed")).toBe(true);

    // A patient cannot be completed without ever arriving.
    expect(canTransition("requested", "completed")).toBe(false);
    expect(canTransition("confirmed", "in_consultation")).toBe(false);
    // Terminal states are terminal.
    expect(canTransition("cancelled", "confirmed")).toBe(false);
    expect(canTransition("completed", "checked_in")).toBe(false);
    expect(canTransition("no_show", "checked_in")).toBe(false);
  });

  it("refuses an illegal transition over HTTP with HMS-STATE-001", async () => {
    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: slotAt(11, 30).toISOString() })
      .expect(201);

    // requested → complete is not an edge. Skipping straight to "done" is exactly
    // how a patient who never arrived ends up billed for a consultation.
    const res = await auth(
      request(app).post(`/api/v1/appointments/${booked.body.data.id}/complete`),
    ).expect(422);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("refuses check-in on a day that is not the appointment day", async () => {
    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: slotAt(12, 0).toISOString() })
      .expect(201);

    await auth(request(app).post(`/api/v1/appointments/${booked.body.data.id}/confirm`)).expect(
      200,
    );

    // The appointment is next Monday; checking in today would put this patient in
    // TODAY's queue and make the doctor's list lie about who is waiting.
    const res = await auth(
      request(app).post(`/api/v1/appointments/${booked.body.data.id}/check-in`),
    ).expect(422);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("rescheduling keeps the original record and links it to the replacement", async () => {
    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: slotAt(12, 30).toISOString() })
      .expect(201);
    const id = booked.body.data.id as string;

    await auth(request(app).post(`/api/v1/appointments/${id}/confirm`)).expect(200);

    const moved = await auth(request(app).post(`/api/v1/appointments/${id}/reschedule`))
      .send({ startAt: slotAt(12, 45).toISOString(), reason: "patient asked for later" })
      .expect(201);

    // The original is retired, NOT overwritten — "booked for 12:30, moved to 12:45"
    // is a fact somebody will need for a complaint or a no-show dispute.
    const original = await auth(request(app).get(`/api/v1/appointments/${id}`)).expect(200);
    expect(original.body.data.status).toBe("rescheduled");
    expect(original.body.data.rescheduledTo).toBe(moved.body.data.booked.id);
    expect(new Date(original.body.data.startAt).getHours()).toBe(12);
    expect(new Date(original.body.data.startAt).getMinutes()).toBe(30);

    // …and it released its slot.
    await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt: slotAt(12, 30).toISOString() })
      .expect(201);
  });
});

describe("a merged patient cannot be booked", () => {
  it("refuses to book onto a chart a human has already retired", async () => {
    const dup = await auth(request(app).post("/api/v1/patients"))
      .send({ name: "Merge Target", gender: "male" })
      .expect(201);
    const survivor = await auth(request(app).post("/api/v1/patients"))
      .send({ name: "Merge Survivor", gender: "male" })
      .expect(201);

    await auth(request(app).post("/api/v1/patients/merge"))
      .send({
        survivorId: survivor.body.data.patient.id,
        duplicateId: dup.body.data.patient.id,
        reason: "same person, confirmed at desk",
      })
      .expect(200);

    // Booking onto the dead record is how a merge silently comes undone: the
    // appointment, and everything later hung off it, lands on the retired chart.
    const res = await auth(request(app).post("/api/v1/appointments"))
      .send({
        patientId: dup.body.data.patient.id,
        doctorId,
        startAt: slotAt(9, 15).toISOString(),
      })
      .expect(422);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });
});
