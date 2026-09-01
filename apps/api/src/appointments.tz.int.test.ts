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
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";
import { Types } from "mongoose";

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
const { getEncounterModel } = await import("./modules/encounters/encounter.model.js");
const { getPatientModel } = await import("./modules/patients/patient.model.js");

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

const app = await listening(createApp(createLogger({ service: "appttz-int-test" })));

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

/* ────────────────────────────────────────────────────────────────────────────
 * THE FRONT DESK'S REGISTER — risk register D2 / runbook GAP-1
 *
 * `GET /encounters?date=YYYY-MM-DD` is the register for one day, and `date` is a DATE rather than
 * an instant precisely because a receptionist thinks in days. Turning that day into a half-open
 * range of instants needs a zone, and the controller used `env.DEFAULT_TIMEZONE`.
 *
 * That was right when a hospital was one site. The MAR, the medication round, the ward worklist
 * and the clinic's own opening hours were all moved to the BRANCH's zone; this was not, so a
 * clerk at a site in another zone asks for "today" and is answered in the hospital default's
 * today. Near a midnight the two are different days and the register shows the wrong set of
 * visits — the ones it omits being the interesting half.
 *
 * The suite's process zone is pinned to Asia/Kolkata and this clinic is America/New_York, so the
 * gap is nine and a half hours: no rounding, offset or clock skew can make a broken
 * implementation pass.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the register's day is the BRANCH's day, not the hospital default's", () => {
  /** A visit that arrived late in the clinic's evening — the far side of the process zone's midnight. */
  const ARRIVED_AT = new Date("2026-08-17T02:00:00.000Z");

  /** The `YYYY-MM-DD` a given instant falls on, in a given zone. */
  function dayKeyIn(instant: Date, zone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  }

  let encounterId = "";
  let clinicDay = "";
  let defaultDay = "";

  beforeAll(async () => {
    clinicDay = dayKeyIn(ARRIVED_AT, CLINIC_ZONE);
    defaultDay = dayKeyIn(ARRIVED_AT, "Asia/Kolkata");

    const created = await auth(request(app).post("/api/v1/encounters")).send({
      patientId,
      doctorId,
      reason: "late evening walk-in",
    });
    expect([200, 201]).toContain(created.status);
    encounterId = created.body.data.encounter.id as string;

    /**
     * Backdated in the database because `arrivedAt` is server-set to "now" — correctly, it is
     * when the patient actually walked in. The register's zone is what is under test, not the
     * clock, so the arrival is placed at a known instant rather than the suite waiting for one.
     */
    const connection = await getTenantConnection({
      id: tenant.id,
      databaseName: tenant.databaseName,
    });
    // `tenantScopePlugin` stamps every query from the request context, so even a setup write
    // has to run inside one.
    await runWithContext(
      { traceId: "appttz-register", tenantId: tenant.id, tenantSlug: SLUG, connection },
      async () => {
        await getEncounterModel(connection).updateOne(
          { _id: encounterId },
          { $set: { arrivedAt: ARRIVED_AT } },
        );
      },
    );
  }, 60_000);

  it("the two zones genuinely disagree about which day this is", () => {
    // The premise, asserted rather than assumed. If these ever coincide the two rows below would
    // both pass against a broken implementation and prove nothing.
    expect(clinicDay).not.toBe(defaultDay);
    expect(clinicDay).toBe("2026-08-16");
    expect(defaultDay).toBe("2026-08-17");
  });

  it("FINDS the visit on the day it happened AT THE CLINIC", async () => {
    const res = await auth(request(app).get("/api/v1/encounters"))
      .query({ date: clinicDay })
      .expect(200);

    expect(
      (res.body.data as { id: string }[]).some((e) => e.id === encounterId),
      `the register for ${clinicDay} at the clinic did not contain a visit that arrived that evening`,
    ).toBe(true);
  });

  it("does NOT find it on the hospital default's day", async () => {
    const res = await auth(request(app).get("/api/v1/encounters"))
      .query({ date: defaultDay })
      .expect(200);

    expect(
      (res.body.data as { id: string }[]).some((e) => e.id === encounterId),
      `the register for ${defaultDay} returned a visit that, at the clinic, happened the day before`,
    ).toBe(false);
  });

  /**
   * ── THE SPAN, NOT JUST THE DAY ────────────────────────────────────────────
   * `dateTo` widens the register to "the 16th through the 22nd". Two things have to hold and both
   * are easy to get wrong: the far end must include its whole day (a half-open bug drops every
   * evening arrival on the closing date), and the span must still be resolved on the BRANCH's
   * clock — a range is just two boundaries, and each one can be computed in the wrong zone
   * independently of the other.
   */
  it("a span includes a visit on its CLOSING day, whole", async () => {
    const res = await auth(request(app).get("/api/v1/encounters"))
      .query({ date: "2026-08-10", dateTo: clinicDay })
      .expect(200);

    expect(
      (res.body.data as { id: string }[]).some((e) => e.id === encounterId),
      "a span ending on the clinic's day dropped a visit that arrived that evening",
    ).toBe(true);
  });

  it("a span that ends the day before excludes it", async () => {
    const res = await auth(request(app).get("/api/v1/encounters"))
      .query({ date: "2026-08-01", dateTo: "2026-08-15" })
      .expect(200);

    expect((res.body.data as { id: string }[]).some((e) => e.id === encounterId)).toBe(false);
  });

  /** The compatibility promise: `date` with no `dateTo` is still exactly one day. */
  it("still means ONE day when no end is given", async () => {
    const res = await auth(request(app).get("/api/v1/encounters"))
      .query({ date: defaultDay })
      .expect(200);

    expect((res.body.data as { id: string }[]).some((e) => e.id === encounterId)).toBe(false);
  });
});

/**
 * THE PATIENT REGISTER'S DATE RANGE — the same rule, on the other list.
 *
 * `GET /patients?from=&to=` narrows the MPI to the days a patient was REGISTERED. It has exactly
 * the failure the encounter register above was built to prove absent: resolve the boundary in the
 * process zone and a clerk in New York asking for "the 16th" is answered with a window that opens
 * at 14:30 on the 15th, silently including and excluding the wrong people. Nine and a half hours
 * of gap means no rounding or DST edge can let a broken implementation through.
 *
 * The half-open end is tested too, because `$lte` the last millisecond is the off-by-one that
 * quietly drops whoever registered just before midnight on the closing day.
 */
describe("the register's DATE RANGE is the branch's days too", () => {
  /** Late evening at the clinic — 22:00 on the 16th in New York, which is the 17th in Kolkata. */
  const REGISTERED_AT = new Date("2026-08-17T02:00:00.000Z");

  function dayKeyIn(instant: Date, zone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  }

  let lateId = "";
  let clinicDay = "";
  let defaultDay = "";

  beforeAll(async () => {
    clinicDay = dayKeyIn(REGISTERED_AT, CLINIC_ZONE);
    defaultDay = dayKeyIn(REGISTERED_AT, "Asia/Kolkata");

    const created = await auth(request(app).post("/api/v1/patients"))
      .send({ name: "Late Evening Walkin", gender: "female", contact: { phone: "9700000042" } })
      .expect(201);
    lateId = created.body.data.patient.id as string;

    /**
     * Backdated straight on the collection: `createdAt` is server-stamped at insert, and what is
     * under test is which DAY a given instant belongs to, not the clock. The raw collection avoids
     * auditPlugin writing "patient updated" for a test fixture.
     */
    const connection = await getTenantConnection({
      id: tenant.id,
      databaseName: tenant.databaseName,
    });
    await runWithContext(
      { traceId: "appttz-mpi-range", tenantId: tenant.id, tenantSlug: SLUG, connection },
      async () => {
        await getPatientModel(connection).collection.updateOne(
          { _id: new Types.ObjectId(lateId) },
          { $set: { createdAt: REGISTERED_AT } },
        );
      },
    );
  }, 60_000);

  const listed = async (query: Record<string, string>): Promise<string[]> => {
    const res = await auth(request(app).get("/api/v1/patients")).query(query).expect(200);
    return (res.body.data as { id: string }[]).map((p) => p.id);
  };

  it("the two zones genuinely disagree about which day this registration is", () => {
    expect(clinicDay).not.toBe(defaultDay);
  });

  it("finds the patient on the day they registered AT THE CLINIC", async () => {
    expect(await listed({ from: clinicDay, to: clinicDay })).toContain(lateId);
  });

  it("does NOT find them on the hospital default's day", async () => {
    expect(await listed({ from: defaultDay, to: defaultDay })).not.toContain(lateId);
  });

  /** `to` closes at the END of its day. A half-open bug drops the last evening of the range. */
  it("includes the closing day whole, not up to its first instant", async () => {
    expect(await listed({ from: "2026-08-10", to: clinicDay })).toContain(lateId);
  });

  it("excludes a range that ends the day before", async () => {
    expect(await listed({ from: "2026-08-01", to: "2026-08-15" })).not.toContain(lateId);
  });

  /** An open-ended range is legal at either end — "everyone since March", "everyone before June". */
  it("accepts `from` alone and `to` alone", async () => {
    expect(await listed({ from: clinicDay })).toContain(lateId);
    expect(await listed({ to: "2026-08-15" })).not.toContain(lateId);
  });

  it("still returns the register when neither bound is given", async () => {
    expect((await listed({})).length).toBeGreaterThan(0);
  });

  it("refuses a malformed date rather than silently ignoring it", async () => {
    await auth(request(app).get("/api/v1/patients")).query({ from: "16-08-2026" }).expect(400);
  });
});
