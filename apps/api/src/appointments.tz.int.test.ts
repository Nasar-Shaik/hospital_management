/**
 * THE CLINIC'S CLOCK — M0 §21 item C, the defect that was scheduled "before M2" and shipped.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────
 * `appointment.service.ts` resolved every day boundary in the PROCESS timezone: `setHours(0,0,0,0)`
 * for the day, `getDay()` for the weekday, `getFullYear/Month/Date` for the leave key. Nothing sets
 * `TZ` in the Dockerfile, the compose file or `.env.example`, so the shipped image runs in UTC —
 * and a clinic configured 09:00–13:00 had its slots generated at 09:00 UTC, which is 14:30 IST.
 * Every appointment in production, at the wrong time.
 *
 * ── WHY NO EXISTING TEST CAUGHT IT ──────────────────────────────────────────
 * `vitest.config.ts` pins `TZ: "Asia/Kolkata"`. The suite ran in the single timezone where process
 * and hospital agree, which is the one timezone in which this bug does not exist. A test that
 * merely asserts "09:00 comes back" passes identically before and after the fix.
 *
 * ── HOW THIS SUITE ESCAPES THE PIN ──────────────────────────────────────────
 * It does not fight the pin — it makes the pin irrelevant. The clinic is put in a branch whose
 * timezone is DELIBERATELY NOT the process zone (`America/New_York`, UTC−4/−5 against IST's
 * +05:30). The old code would answer in Kolkata whatever the branch said; the new code answers in
 * New York. The gap is nine and a half hours, so no rounding, no DST edge and no clock skew can
 * make a broken implementation pass.
 *
 * The assertions are on the UTC INSTANT, because that is what is stored, what is sent, and what a
 * phone in a third timezone will render from.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("appointmentsTz");
process.env.MONGO_MASTER_DB = "test_appttz_master";
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

const SLUG = "test-appttz";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

/**
 * The clinic's zone, chosen against the suite's own `TZ` pin.
 *
 * `America/New_York` is UTC−4 in August. The process runs at UTC+05:30. A 09:00 clinic is
 * therefore 13:00Z at the clinic and 03:30Z if the process zone leaks in — nine and a half hours
 * apart, which no implementation can straddle by accident.
 */
const CLINIC_ZONE = "America/New_York";

const app = createApp(createLogger({ service: "appttz-int-test" }));

let tenant: { id: string; slug: string; databaseName: string };
let token = "";
let doctorId = "";
let patientId = "";
let branchId = "";

function auth(req: request.Test): request.Test {
  return req
    .set("Host", HOST)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Active-Branch", branchId);
}

/** The wall-clock hour a UTC instant reads as, AT THE CLINIC. */
function hourAtClinic(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/**
 * An INSTANT safely inside the clinic's day, which is what the wire actually carries.
 *
 * `?date=` is `z.coerce.date()` and the shipped client sends `date.toISOString()`, so these tests
 * send an instant too. Noon at the clinic is chosen deliberately: it is the furthest point from
 * either midnight, so no offset, no DST edge and no clock skew can push it into a neighbouring day.
 */
function clinicNoon(dayKey: string): string {
  // Probe UTC noon, read what the clinic's clock says, and correct — one pass is exact for a
  // whole-hour offset and within an hour for the half-hour zones, which noon absorbs.
  const probe = new Date(`${dayKey}T12:00:00Z`);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_ZONE,
      hour: "2-digit",
      hour12: false,
    }).format(probe),
  );
  return new Date(probe.getTime() + (12 - (hour % 24)) * 3_600_000).toISOString();
}

/** The next date (YYYY-MM-DD) that is a Monday AT THE CLINIC, at least a week out. */
function nextClinicMonday(): string {
  for (let i = 7; i < 21; i += 1) {
    const probe = new Date(Date.now() + i * 86_400_000);
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: CLINIC_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(probe);
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: CLINIC_ZONE,
      weekday: "short",
    }).format(probe);
    if (weekday === "Mon") return key;
  }
  throw new Error("no Monday in the next three weeks — the calendar is broken");
}

let monday = "";

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_appttz_master", DB]);
  await flushTestCache("appointmentsTz");

  const t = await provisionTenant({
    hospitalName: "Clinic Clock",
    slug: SLUG,
    planCode: "PLAN_HOSPITAL", // branches + appointments
  });
  tenant = { id: t.tenant.id, slug: SLUG, databaseName: t.tenant.databaseName };

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });

  await runWithContext(
    { traceId: "appttz-setup", tenantId: tenant.id, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();

      const admin = await createUser({ email: "admin@tz.test", name: "Admin", status: "invited" });
      await setPassword(admin.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(admin.id, "TENANT_ADMIN", []);
      await transitionStatus(admin.id, "active");

      const doctor = await createUser({ email: "doc@tz.test", name: "Dr West", status: "invited" });
      await assignRoleByCode(doctor.id, "DOCTOR", []);
      await transitionStatus(doctor.id, "active");
      doctorId = doctor.id;
    },
  );

  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email: "admin@tz.test", password: PASSWORD });
  token = login.body.data.accessToken as string;

  /**
   * The branch IS the clinic's clock — its timezone is what every boundary must resolve through.
   *
   * Provisioning already seeds a main branch, and the edition caps how many a hospital may have,
   * so this MOVES the existing one rather than adding a second. That is also the realistic shape:
   * a hospital sets the timezone on the site it already has.
   */
  const branches = await request(app)
    .get("/api/v1/branches")
    .set("Host", HOST)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  branchId = (branches.body.data as { id: string }[])[0]!.id;

  await request(app)
    .patch(`/api/v1/branches/${branchId}`)
    .set("Host", HOST)
    .set("Authorization", `Bearer ${token}`)
    .send({ timezone: CLINIC_ZONE })
    .expect(200);

  monday = nextClinicMonday();

  // Mondays, 09:00–13:00 AT THE CLINIC, 60-minute slots → 4 slots.
  await auth(request(app).put("/api/v1/doctors/schedule"))
    .send({ doctorId, weekday: 1, startMinute: 540, endMinute: 780, slotMinutes: 60 })
    .expect(201);

  const patient = await auth(request(app).post("/api/v1/patients"))
    .send({ name: "TZ Patient", gender: "male", contact: { phone: "9000000999" } })
    .expect(201);
  patientId = patient.body.data.patient.id as string;
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_appttz_master", DB]);
}, 30_000);

describe("slots are generated in the CLINIC's zone, not the server's", () => {
  it("offers 09:00 as 09:00 where the clinic is — not 09:00 where the process is", async () => {
    const res = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(monday) })
      .expect(200);

    const slots = res.body.data as { startAt: string }[];
    expect(slots).toHaveLength(4);

    /**
     * THE assertion. Read back in the clinic's zone, the session starts at 09:00 and ends at 13:00.
     * Under the old process-zone arithmetic on this suite's `TZ=Asia/Kolkata`, the first slot was
     * 09:00 IST = 03:30Z, which reads as 23:30 the PREVIOUS DAY in New York.
     */
    expect(hourAtClinic(slots[0]!.startAt)).toBe("09:00");
    expect(hourAtClinic(slots[3]!.startAt)).toBe("12:00");
  });

  it("puts those slots on the right UTC instant, which is what actually gets stored", async () => {
    const res = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(monday) })
      .expect(200);

    const first = new Date((res.body.data as { startAt: string }[])[0]!.startAt);

    // 09:00 in New York in August (EDT, UTC−4) is 13:00Z. 09:00 IST would be 03:30Z.
    expect(first.getUTCHours()).toBe(13);
    expect(first.getUTCMinutes()).toBe(0);
    expect(first.getUTCHours()).not.toBe(3);
  });

  it("resolves the WEEKDAY at the clinic, so a Monday clinic is not read as a Sunday", async () => {
    /**
     * The subtler half of the same defect. `getDay()` answers for the process, and there are hours
     * of every day during which the two zones disagree about the date — 9.5 hours of them here.
     * A Monday schedule looked up on a Sunday weekday finds nothing and returns an empty grid,
     * which reads exactly like "this doctor does not work Mondays".
     */
    const sunday = new Date(`${monday}T00:00:00Z`);
    sunday.setUTCDate(sunday.getUTCDate() - 1);
    const sundayKey = sunday.toISOString().slice(0, 10);

    const onSunday = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(sundayKey) })
      .expect(200);
    expect(onSunday.body.data).toEqual([]);

    const onMonday = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(monday) })
      .expect(200);
    expect((onMonday.body.data as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("booking and leave agree with the clinic's calendar", () => {
  it("accepts a slot the availability screen offered, at the instant it offered it", async () => {
    const slots = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(monday) })
      .expect(200);
    const startAt = (slots.body.data as { startAt: string }[])[1]!.startAt;

    const booked = await auth(request(app).post("/api/v1/appointments"))
      .send({ patientId, doctorId, startAt })
      .expect(201);

    // Booking re-derives the schedule independently of the availability read. If the two resolved
    // the day differently, this would be "the doctor has no clinic session at that time" — which
    // is precisely the shape the old code failed in, and the one a clerk cannot act on.
    expect(new Date(booked.body.data.startAt).toISOString()).toBe(new Date(startAt).toISOString());
    expect(hourAtClinic(booked.body.data.startAt)).toBe("10:00");
  });

  it("matches leave on the clinic's day key, not the server's", async () => {
    /**
     * Leave is stored as `YYYY-MM-DD` with no zone. Which day an instant belongs to therefore has
     * to be asked of the clinic — otherwise a doctor on leave "Monday" is still bookable for the
     * 9.5 hours of that Monday during which the server thinks it is Sunday or Tuesday.
     */
    await auth(request(app).post("/api/v1/doctors/leave"))
      .send({ doctorId, fromDate: monday, toDate: monday, reason: "away" })
      .expect(201);

    const res = await auth(request(app).get("/api/v1/appointments/availability"))
      .query({ doctorId, date: clinicNoon(monday) })
      .expect(200);
    expect(res.body.data).toEqual([]);
  });
});
