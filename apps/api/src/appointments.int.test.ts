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
/** Dr Rao's own token, and a SECOND doctor — the roster is only safe if it is safe from a peer. */
let doctorToken = "";
let otherDoctorId = "";
let otherDoctorToken = "";
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
      await setPassword(doctor.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(doctor.id, "DOCTOR", []);
      await transitionStatus(doctor.id, "active");
      doctorId = doctor.id;

      const other = await createUser({
        email: "doc2@appt.test",
        name: "Dr Iyer",
        status: "invited",
      });
      await setPassword(other.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(other.id, "DOCTOR", []);
      await transitionStatus(other.id, "active");
      otherDoctorId = other.id;
    },
  );

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email: "admin@appt.test", password: PASSWORD });
  token = login.body.data.accessToken as string;

  const signIn = async (email: string): Promise<string> => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Host", HOST)
      .send({ email, password: PASSWORD });
    return res.body.data.accessToken as string;
  };
  doctorToken = await signIn("doc@appt.test");
  otherDoctorToken = await signIn("doc2@appt.test");

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
    // A real 09:00 Monday slot (so the doctor works then — this isolates the "past"
    // rejection from "no such slot"), but a PAST one. Two weeks back, not one:
    // `clinicDay` is *next* Monday, so `clinicDay - 7` is *this* Monday — which is
    // today when the suite runs on a Monday, and "today 09:00" is still in the future
    // before 9am, so the booking would (correctly) be accepted and the test flake.
    // `clinicDay - 14` is always a Monday strictly in the past.
    const past = new Date(clinicDay);
    past.setDate(past.getDate() - 14);
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

/* ════════════════════════════════════════════════════════════════════════════
 * A DOCTOR'S OWN ROSTER (`doctor:self-manage`)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── THE FAILURE THIS CLOSES ─────────────────────────────────────────────────
 * The roster was administrable ONLY by `doctor:manage`, which TENANT_ADMIN alone holds. So a
 * doctor could read the appointment book and had no way to say they would not be there: marking
 * yourself off sick meant finding an administrator, at 07:00, before a clinic you are not going to
 * attend. What happens instead is nothing — reception books into sessions nobody will sit, and the
 * patients travel.
 *
 * ── AND THE THING IT MUST NOT OPEN ──────────────────────────────────────────
 * A permission held by every doctor is a permission held by anyone who compromises one doctor. So
 * the tests that matter here are the negative ones: not "can a doctor manage their roster", but
 * "can a doctor reach a COLLEAGUE's roster, or the clinic HOURS, by any route in the API". Both
 * answers must stay no, and neither is guaranteed by the happy path passing.
 */
function asDoctor(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${doctorToken}`);
}

function asOtherDoctor(req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${otherDoctorToken}`);
}

/** `YYYY-MM-DD` in the server's own local calendar — the shape leave is stored in. */
function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

describe("a doctor manages their own sessions and leave", () => {
  it("sets their own weekday sessions, stamped with THEIR id and not the body's", async () => {
    const res = await asDoctor(request(app).put("/api/v1/doctors/me/availability"))
      .send({ weekday: 3, sessions: ["morning", "evening"] })
      .expect(200);

    expect(res.body.data.doctorId).toBe(doctorId);
    expect(res.body.data.sessions).toEqual(["morning", "evening"]);
  });

  it("refuses a body that tries to name a doctor at all", async () => {
    /**
     * The control is the SCHEMA, not a check in the handler. `.strict()` means an id sent here is
     * rejected outright rather than silently dropped — so a client written against the admin
     * endpoint fails loudly instead of appearing to work while writing to its own roster.
     */
    const res = await asDoctor(request(app).put("/api/v1/doctors/me/availability"))
      .send({ doctorId: otherDoctorId, weekday: 3, sessions: ["morning"] })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("books its own leave, and the leave actually removes the slots reception can see", async () => {
    // The whole point of the feature: an absence a doctor records must reach the booking screen.
    const before = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: dayKey(clinicDay) })
      .expect(200);
    expect(before.body.data.length).toBeGreaterThan(0);

    const leave = await asDoctor(request(app).post("/api/v1/doctors/me/leave"))
      .send({ fromDate: dayKey(clinicDay), toDate: dayKey(clinicDay), reason: "unwell" })
      .expect(201);
    expect(leave.body.data.doctorId).toBe(doctorId);

    const after = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: dayKey(clinicDay) })
      .expect(200);
    expect(after.body.data).toEqual([]);

    // …and cancelling it puts the clinic back, so a doctor who recovers is not stuck.
    await asDoctor(request(app).delete(`/api/v1/doctors/me/leave/${leave.body.data.id}`)).expect(
      200,
    );

    const restored = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: dayKey(clinicDay) })
      .expect(200);
    expect(restored.body.data.length).toBe(before.body.data.length);
  });
});

describe("a doctor cannot reach a colleague's roster, or anyone's clinic hours", () => {
  it("cannot cancel another doctor's leave — and it is still there afterwards", async () => {
    const theirs = await asOtherDoctor(request(app).post("/api/v1/doctors/me/leave"))
      .send({ fromDate: "2027-03-01", toDate: "2027-03-03", reason: "conference" })
      .expect(201);
    const leaveId = theirs.body.data.id as string;

    /**
     * 404, not 403, and deliberately: a 403 would confirm that this id names a real leave row
     * belonging to a colleague, which is roster information `doctor:self-manage` does not grant.
     * The refusal is indistinguishable from "no such row".
     */
    const res = await asDoctor(request(app).delete(`/api/v1/doctors/me/leave/${leaveId}`)).expect(
      404,
    );
    expect(res.body.error.code).toBe("HMS-GEN-404");

    // The important half: the refusal did not merely answer 404, it left the row alone.
    const still = await asOtherDoctor(
      request(app).get(`/api/v1/doctors/${otherDoctorId}/leave`),
    ).expect(200);
    expect((still.body.data as { id: string }[]).some((l) => l.id === leaveId)).toBe(true);
  });

  it("ignores a doctorId smuggled into the DELETE body", async () => {
    /**
     * ── WHY THIS TEST EXISTS: A FALSIFICATION THAT REDDENED NOTHING ──────────
     * Rewriting the handler to prefer `req.body.doctorId` over the token broke NO test. The route
     * validates `params` only — a DELETE carries no schema for its body — so the one place an
     * attacker would put a colleague's id was the one place nothing looked.
     *
     * The handler is correct (it reads `requireAuth(req).userId`), but "correct and untested" is
     * how it stops being correct six months from now. This asserts the body is inert.
     */
    const theirs = await asOtherDoctor(request(app).post("/api/v1/doctors/me/leave"))
      .send({ fromDate: "2027-05-01", toDate: "2027-05-02", reason: "study leave" })
      .expect(201);
    const leaveId = theirs.body.data.id as string;

    await asDoctor(request(app).delete(`/api/v1/doctors/me/leave/${leaveId}`))
      .send({ doctorId: otherDoctorId })
      .expect(404);

    const still = await asOtherDoctor(
      request(app).get(`/api/v1/doctors/${otherDoctorId}/leave`),
    ).expect(200);
    expect((still.body.data as { id: string }[]).some((l) => l.id === leaveId)).toBe(true);
  });

  it("cannot write a colleague's roster through the administrator's route", async () => {
    // The self-service permission must not be a back door to the one it is NOT.
    await asDoctor(request(app).put("/api/v1/doctors/availability"))
      .send({ doctorId: otherDoctorId, weekday: 2, sessions: ["morning"] })
      .expect(403);

    await asDoctor(request(app).post("/api/v1/doctors/leave"))
      .send({ doctorId: otherDoctorId, fromDate: "2027-04-01", toDate: "2027-04-02" })
      .expect(403);
  });

  it("cannot set clinic HOURS, which stay an administrator's decision", async () => {
    /**
     * The deliberate line. Sessions and leave are a doctor's own business; the clock hours that
     * generate bookable slots are contractual — how long the clinic runs and at what interval
     * patients are booked is not something the person being booked should set unilaterally.
     */
    await asDoctor(request(app).put("/api/v1/doctors/schedule"))
      .send({ doctorId, weekday: 1, startMinute: 540, endMinute: 1200, slotMinutes: 5 })
      .expect(403);
  });
});
