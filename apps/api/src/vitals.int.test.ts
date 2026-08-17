/**
 * NURSE VITALS CAPTURE — release-gating (M3-S4).
 *
 * ── THE FOUR CLAIMS ─────────────────────────────────────────────────────────
 *
 *   1. A NURSE CAN CHART OBSERVATIONS, AND ONLY A NURSE-OR-CLINICIAN CAN. `vitals:record` is the
 *      permission and it is the whole authorization — the desk books and takes money, it does not
 *      measure patients.
 *
 *   2. A RETRY AFTER A LOST RESPONSE CHARTS ONE READING, NOT TWO — AND A GENUINE SECOND
 *      OBSERVATION IS STILL POSSIBLE. These pull in opposite directions and both are required.
 *      Idempotency is about ONE request being repeated; two nurses taking a pulse ten minutes
 *      apart is two observations and the chart must hold both. Any "de-duplication" that
 *      confused the two would silently refuse to record a deteriorating patient.
 *
 *   3. A VALUE IS NEVER SILENTLY ALTERED. An implausible figure is REFUSED, with the field named;
 *      it is never clamped to a boundary and charted as though the nurse typed it.
 *
 *   4. THE BOUNDARIES HOLD. An encounter in another branch, or another hospital, is not
 *      chartable — and the check is the SERVER's, not the phone's.
 *
 * The reference-range flags are asserted too, in one place: they are what the whole "server
 * flags are authoritative" rule on the mobile side depends on being true.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("vitals");
process.env.MONGO_MASTER_DB = "test_vitals_master";
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
const { seedTariff } = await import("./seed/tariff.js");

const SLUG = "test-vitals";
const OTHER_SLUG = "test-vitals-rival";
const PASSWORD = "V4lid!Password#2026";
const DB = `hms_${SLUG}`;
const OTHER_DB = `hms_${OTHER_SLUG}`;

const app = await listening(createApp(createLogger({ service: "vitals-int-test" })));

interface Site {
  id: string;
  host: string;
  admin: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const main = {} as Site;
const rival = {} as Site;

let doctorToken = "";
let nurseToken = "";
let nurse2Token = "";
let nurseId = "";
let receptionToken = "";
/** A nurse bound to the SECOND site only — the wrong-branch probe. */
let siteBNurseToken = "";
let siteA = "";
let siteB = "";
/** An admitted patient at the rival hospital, for the cross-tenant probe. */
let rivalEncounter = "";

function req(
  method: "get" | "post",
  path: string,
  token: string,
  host: string,
  activeBranch?: string,
): request.Test {
  const r = request(app)[method](path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return activeBranch ? r.set("X-Active-Branch", activeBranch) : r;
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status}`);
  return res.body.data.accessToken as string;
}

async function makeUser(
  email: string,
  name: string,
  role: string,
  branchIds: string[],
): Promise<string> {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, branchIds);
  await transitionStatus(u.id, "active");
  return u.id;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, OTHER_DB]);
  await flushTestCache("vitals");

  for (const [site, slug, branches] of [
    [main, SLUG, 2],
    [rival, OTHER_SLUG, 1],
  ] as [Site, string, number][]) {
    const t = await provisionTenant({
      hospitalName: slug,
      slug,
      planCode: "PLAN_HOSPITAL",
      organizationType: "private_hospital",
      maxBranches: branches,
    });
    site.id = t.tenant.id;
    site.host = `${slug}.medicore.test`;
    site.connection = await getTenantConnection({
      id: t.tenant.id,
      databaseName: t.tenant.databaseName,
    });
    await seedTariff(t.tenant.id, slug, site.connection);
    await runWithContext(
      {
        traceId: `setup-${slug}`,
        tenantId: site.id,
        tenantSlug: slug,
        connection: site.connection,
      },
      async () => {
        await seedRbac();
        await makeUser(`admin@${slug}.test`, "Admin", "TENANT_ADMIN", []);
      },
    );
    site.admin = await login(site.host, `admin@${slug}.test`);
  }

  /**
   * The branches are read and created BEFORE any branch-scoped staff exist, because a
   * hospital-wide admin cannot write once there are two sites and no active branch to pick — the
   * lesson from S1. Staff are then bound to one site each.
   */
  const branches = await req("get", "/api/v1/branches", main.admin, main.host).expect(200);
  siteA = (branches.body.data as { id: string }[])[0]?.id as string;
  const b = await req("post", "/api/v1/branches", main.admin, main.host)
    .send({ name: "Riverside", code: "RIV" })
    .expect(201);
  siteB = b.body.data.id as string;

  let doctorId = "";
  await runWithContext(
    { traceId: "setup-staff", tenantId: main.id, tenantSlug: SLUG, connection: main.connection },
    async () => {
      doctorId = await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [siteA]);
      nurseId = await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [siteA]);
      // The second observer on the same bay — two nurses charting the same patient minutes apart
      // is the ordinary case, and the chart must hold both.
      await makeUser(`nurse2@${SLUG}.test`, "Sister Anna", "NURSE", [siteA]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [siteA]);
      await makeUser(`nurseb@${SLUG}.test`, "Sister Grace", "NURSE", [siteB]);
    },
  );

  doctorToken = await login(main.host, `doc@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);
  nurse2Token = await login(main.host, `nurse2@${SLUG}.test`);
  receptionToken = await login(main.host, `front@${SLUG}.test`);
  siteBNurseToken = await login(main.host, `nurseb@${SLUG}.test`);
  doctorAtA = doctorId;

  // The rival hospital's own patient, so "another tenant's encounter id" is a REAL id somewhere.
  await runWithContext(
    {
      traceId: "setup-rival",
      tenantId: rival.id,
      tenantSlug: OTHER_SLUG,
      connection: rival.connection,
    },
    async () => {
      rivalDoctorId = await makeUser(`doc@${OTHER_SLUG}.test`, "Dr Rival", "DOCTOR", []);
      await makeUser(`front@${OTHER_SLUG}.test`, "Desk Rival", "RECEPTIONIST", []);
    },
  );
  rivalEncounter = await admitAt(rival, "Rival Patient");
}, 180_000);

let doctorAtA = "";
let rivalDoctorId = "";

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, OTHER_DB]);
}, 30_000);

/* ── fixtures ──────────────────────────────────────────────────────────────── */

/**
 * An ADMITTED patient. Returns the INPATIENT encounter id.
 *
 * The queue/start steps are not ceremony: `arrived → admitted` is not a legal edge, so a patient
 * must actually have been seen before they can be given a bed.
 */
async function admitAt(site: Site, name: string, branch?: string): Promise<string> {
  const isMain = site === main;
  const desk = isMain ? receptionToken : await login(site.host, `front@${OTHER_SLUG}.test`);
  const doc = isMain ? doctorToken : await login(site.host, `doc@${OTHER_SLUG}.test`);
  // An encounter needs a queue to join, and the doctor IS the queue — `arrived` with nowhere to
  // wait is refused, at either hospital.
  const department = isMain ? doctorAtA : rivalDoctorId;

  const patient = await req("post", "/api/v1/patients", desk, site.host, branch)
    .send({ name, gender: "female", contact: { phone: `9${Math.floor(Math.random() * 1e9)}` } })
    .expect(201);

  const enc = await req("post", "/api/v1/encounters", desk, site.host, branch)
    .send({ patientId: patient.body.data.patient.id, departmentId: department })
    .expect(201);
  const opId = enc.body.data.encounter.id as string;

  await req("post", `/api/v1/encounters/${opId}/queue`, desk, site.host, branch);
  await req("post", `/api/v1/encounters/${opId}/start`, doc, site.host, branch).expect(200);

  const admitted = await req("post", `/api/v1/encounters/${opId}/admit`, doc, site.host, branch)
    .send({
      ward: "General",
      bedCode: `B-${Math.floor(Math.random() * 1e6)}`,
      tariffCode: "BED_GEN",
    })
    .expect(201);

  return admitted.body.data.inpatient.id as string;
}

const admit = (name: string): Promise<string> => admitAt(main, name, siteA);

function chart(
  encounterId: string,
  body: Record<string, unknown>,
  token = nurseToken,
  key?: string,
  branch = siteA,
) {
  const r = req("post", `/api/v1/encounters/${encounterId}/vitals`, token, main.host, branch);
  if (key) r.set("Idempotency-Key", key);
  return r.send(body);
}

const readChart = (encounterId: string, token = nurseToken, branch = siteA) =>
  req("get", `/api/v1/encounters/${encounterId}/vitals`, token, main.host, branch);

/* ── 1. who may chart ──────────────────────────────────────────────────────── */

describe("authorization", () => {
  it("lets a NURSE chart observations, stamped with the observer and the site", async () => {
    const enc = await admit("Obs Subject");
    const res = await chart(enc, { pulse: 72, systolic: 118, diastolic: 76 }).expect(201);

    expect(res.body.data).toMatchObject({
      encounterId: enc,
      pulse: 72,
      systolic: 118,
      diastolic: 76,
      recordedBy: nurseId,
      branchId: siteA,
    });
    // The observer of record is taken from the authenticated caller, never from the body.
    expect(res.body.data.recordedAt).toBeTruthy();
  });

  /**
   * ── A DOCUMENTED GRANT THAT DOES NOT EXIST (found in M3-S4) ───────────────
   * `vitals.routes.ts` said `vitals:record` belongs to "NURSES above all …, and doctors, who take
   * observations too". The seeded DOCTOR role does not hold it, and never has: the permission
   * appears once in the catalogue, under NURSE. So a doctor charting a blood pressure at the
   * bedside gets a 403.
   *
   * This test pins what the system ACTUALLY does rather than what the comment claimed, and the
   * comment has been corrected to match. Whether DOCTOR should be granted it is a hospital's
   * policy decision — a role grant is not something a mobile slice should make in passing — and it
   * is reported rather than done. The catalogue is editable per tenant, so a hospital that wants
   * it can add it without a code change.
   */
  it("refuses a DOCTOR — the seeded role does not hold vitals:record", async () => {
    const enc = await admit("Doctor Obs");
    await chart(enc, { pulse: 80 }, doctorToken).expect(403);
  });

  /**
   * ── THE DESK NOW MEASURES THE PATIENT, DELIBERATELY ───────────────────────
   * This test asserted the opposite ("the desk books and takes money, it does not measure
   * patients") and was correct about the code at the time. The policy has since been changed on
   * purpose, not weakened by accident: while NURSE was the sole holder of `vitals:record`, and
   * there is no nurse at the front door, NOTHING was measured before the consultation at all. In
   * an Indian OPD the weighing scale is beside the counter.
   *
   * Rewritten rather than deleted, so the reversal is visible in the history of the file that
   * held the old rule. What the desk may do is now stated positively, and the two tests below
   * fence what it still may NOT.
   */
  it("lets the front desk chart the intake observations", async () => {
    const enc = await admit("Front Desk Obs");
    const res = await chart(
      enc,
      { pulse: 72, systolic: 124, diastolic: 82, heightCm: 170, weightKg: 68 },
      receptionToken,
    ).expect(201);

    // BMI is DERIVED, never entered: 68 / 1.70² = 23.5. The desk types two numbers it can
    // actually measure, and the arithmetic nobody should do by hand is the server's.
    expect(res.body.data.bmi).toBe(23.5);
  });

  it("lets the desk read back the observations it just took", async () => {
    /**
     * Not a formality. A desk that may WRITE a measurement but not read it cannot print it on the
     * OP slip it hands the patient — which was the whole point of taking it. This is why
     * `vitals:read` was split out of `emr:read`.
     */
    const enc = await admit("Desk Reads Back");
    await chart(enc, { heightCm: 160, weightKg: 55 }, receptionToken).expect(201);

    const res = await readChart(enc, receptionToken).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].bmi).toBe(21.5);
  });

  it("still refuses the desk the patient's TREND across visits", async () => {
    /**
     * The line that survived the policy change, and the reason the split is worth having. Today's
     * intake is the desk's business; the patient's clinical history is not. That read stays behind
     * `emr:read`, which the front desk does not hold.
     */
    const enc = await admit("Desk Trend Denied");
    await chart(enc, { pulse: 70 }, receptionToken).expect(201);

    const encounter = await request(app)
      .get(`/api/v1/encounters/${enc}`)
      .set("Host", main.host)
      .set("Authorization", `Bearer ${nurseToken}`)
      .set("X-Active-Branch", siteA)
      .expect(200);

    await request(app)
      .get(`/api/v1/patients/${encounter.body.data.patientId as string}/vitals`)
      .set("Host", main.host)
      .set("Authorization", `Bearer ${receptionToken}`)
      .set("X-Active-Branch", siteA)
      .expect(403);
  });

  it("refuses an unauthenticated request outright", async () => {
    const enc = await admit("Anon Obs");
    await request(app)
      .post(`/api/v1/encounters/${enc}/vitals`)
      .set("Host", main.host)
      .send({ pulse: 72 })
      .expect(401);
  });

  /**
   * The UI hides the save control without the permission; this is the reason that is only a
   * convenience. A request built by hand reaches the same refusal.
   *
   * The probe is the DOCTOR now that the desk holds the grant — the claim is about the server
   * refusing whoever lacks the permission, and it needs a caller who actually lacks it.
   */
  it("refuses the write even when the caller skips the app entirely", async () => {
    const enc = await admit("Bypass Obs");
    const res = await chart(enc, { pulse: 72 }, doctorToken);
    expect(res.status).toBe(403);
    expect((await readChart(enc)).body.data).toHaveLength(0);
  });
});

/* ── 2. validation is the server's ─────────────────────────────────────────── */

describe("validation", () => {
  it("accepts a single measurement — a pulse alone is a real observation", async () => {
    const enc = await admit("Lone Pulse");
    await chart(enc, { pulse: 66 }).expect(201);
  });

  it("refuses an empty reading", async () => {
    const enc = await admit("Empty Obs");
    const res = await chart(enc, {}).expect(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
    // A chart of empty rows looks like care that was given and was not.
    expect((await readChart(enc)).body.data).toHaveLength(0);
  });

  /**
   * ── ABNORMAL IS RECORDABLE; IMPLAUSIBLE IS NOT ────────────────────────────
   * A systolic of 250 is a hypertensive emergency and the chart is what proves it. Refusing it
   * would be refusing to chart the sickest patients in the hospital, who are the ones the chart
   * exists for. 2500 is a slipped finger.
   */
  it("charts a frighteningly abnormal but possible figure", async () => {
    const enc = await admit("Emergency Obs");
    const res = await chart(enc, { systolic: 250, diastolic: 130, spo2: 82 }).expect(201);
    expect(res.body.data.systolic).toBe(250);
  });

  it("refuses a figure outside physical possibility", async () => {
    const enc = await admit("Typo Obs");
    const res = await chart(enc, { systolic: 2500 }).expect(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(Object.keys(res.body.error.details.fields)).toContain("systolic");
  });

  /**
   * ── THE NO-CLAMP CONTROL ──────────────────────────────────────────────────
   * The refusal must leave NOTHING behind. A server that clamped 2500 to 300 and charted it would
   * produce a reading nobody typed, and the person who would have caught it is the one whose
   * entry was changed.
   */
  it("charts nothing at all when a figure is refused", async () => {
    const enc = await admit("No Clamp");
    await chart(enc, { systolic: 2500, pulse: 72 }).expect(400);
    expect((await readChart(enc)).body.data).toHaveLength(0);
  });

  /** The commonest vitals entry error there is: the two figures in the wrong boxes. */
  it("refuses a diastolic at or above the systolic", async () => {
    const enc = await admit("Reversed BP");
    const res = await chart(enc, { systolic: 80, diastolic: 120 }).expect(400);
    expect(Object.keys(res.body.error.details.fields)).toContain("diastolic");
    await chart(enc, { systolic: 120, diastolic: 120 }).expect(400);
  });

  it("refuses a decimal where the domain records whole units", async () => {
    const enc = await admit("Fractional Pulse");
    await chart(enc, { pulse: 72.5 }).expect(400);
  });

  /**
   * A future stamp is a mis-keyed year, and it would displace the real latest observation.
   *
   * ── TWO SHAPES OF HMS-VAL-001, AND THIS IS THE OTHER ONE ──────────────────
   * The zod middleware wraps field errors as `details.fields`; a SERVICE-level refusal like this
   * one puts them at the top of `details`. That is the convention across the whole codebase — over
   * twenty service throws, none of them use `fields` — so this suite asserts what the API actually
   * returns rather than "fixing" a convention in a vitals slice. The mobile screen reads
   * `fieldErrors` for the first shape and falls back to the message for the second, so a nurse
   * sees the reason either way.
   */
  it("refuses an observation recorded in the future", async () => {
    const enc = await admit("Future Obs");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const res = await chart(enc, { pulse: 72, recordedAt: tomorrow }).expect(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(res.body.error.details).toHaveProperty("recordedAt");
    expect((await readChart(enc)).body.data).toHaveLength(0);
  });

  it("refuses a field the schema does not know", async () => {
    const enc = await admit("Unknown Field");
    await chart(enc, { pulse: 72, bloodSugar: 5.4 }).expect(400);
  });
});

/* ── 3. the flags are the server's ─────────────────────────────────────────── */

describe("server-side assessment", () => {
  /**
   * This is the fact the whole mobile "never compute a threshold locally" rule rests on. If the
   * API stopped returning `flags` and `abnormal`, the phone would have nothing to paint — which is
   * the correct failure, and far better than two copies of a reference range drifting apart.
   */
  it("returns a per-field flag and an overall abnormal bit", async () => {
    const enc = await admit("Flagged Obs");
    const res = await chart(enc, { pulse: 130, spo2: 98, temperature: 37.0 }).expect(201);

    expect(res.body.data.flags).toMatchObject({
      pulse: "high",
      spo2: "normal",
      temperature: "normal",
    });
    expect(res.body.data.abnormal).toBe(true);
  });

  it("calls a wholly in-range reading normal", async () => {
    const enc = await admit("Normal Obs");
    const res = await chart(enc, { pulse: 72, spo2: 98 }).expect(201);
    expect(res.body.data.abnormal).toBe(false);
  });

  /** Derived on the same reading only — never from a height carried forward from another day. */
  it("derives BMI when both halves are on the same reading, and not otherwise", async () => {
    const enc = await admit("BMI Obs");
    const both = await chart(enc, { weightKg: 70, heightCm: 170 }).expect(201);
    expect(both.body.data.bmi).toBeCloseTo(24.2, 1);

    const weightOnly = await chart(enc, { weightKg: 71 }).expect(201);
    expect(weightOnly.body.data.bmi).toBeUndefined();
  });

  it("does not flag a height — a height is not abnormal, it is just a height", async () => {
    const enc = await admit("Height Obs");
    const res = await chart(enc, { heightCm: 150 }).expect(201);
    expect(res.body.data.flags.heightCm).toBeUndefined();
    expect(res.body.data.abnormal).toBe(false);
  });
});

/* ── 4. a retry is not a second observation ────────────────────────────────── */

describe("idempotency", () => {
  /**
   * ── THE LOST-RESPONSE CASE ────────────────────────────────────────────────
   * The request reached the server, the reading was charted, the response never arrived. The
   * nurse presses save again with the SAME key: the server replays the original 201 and writes
   * nothing. Without this the chart gets a phantom second reading, permanently.
   */
  it("replays the original reading for a repeated key and writes nothing", async () => {
    const enc = await admit("Replay Obs");
    const key = "vitals-replay-001";

    const first = await chart(enc, { pulse: 74, spo2: 97 }, nurseToken, key).expect(201);
    const second = await chart(enc, { pulse: 74, spo2: 97 }, nurseToken, key).expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers["idempotency-replayed"]).toBeTruthy();
    expect((await readChart(enc)).body.data).toHaveLength(1);
  });

  /** A key names ONE intent. Reusing it for different figures is a client bug, and is refused. */
  it("refuses the same key with a different body", async () => {
    const enc = await admit("Conflict Obs");
    const key = "vitals-conflict-001";

    await chart(enc, { pulse: 74 }, nurseToken, key).expect(201);
    const clash = await chart(enc, { pulse: 99 }, nurseToken, key).expect(409);
    expect(clash.body.error.code).toBe("HMS-REQ-002");
    expect((await readChart(enc)).body.data).toHaveLength(1);
  });

  it("rejects a malformed key rather than ignoring it", async () => {
    const enc = await admit("Short Key");
    // Silently dropping a bad key would leave a client believing it is protected when it is not.
    await chart(enc, { pulse: 72 }, nurseToken, "abc").expect(400);
  });

  /**
   * Two presses at the same instant. One wins, and whichever way the race falls the chart holds
   * exactly one reading.
   */
  it("survives two concurrent submissions of the same key", async () => {
    const enc = await admit("Race Obs");
    const key = "vitals-race-0001";

    const results = await Promise.allSettled([
      chart(enc, { pulse: 88 }, nurseToken, key),
      chart(enc, { pulse: 88 }, nurseToken, key),
    ]);

    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    // 201 + (201 replayed | 409 in-flight) — never two independent creations.
    expect(codes[0]).toBe(201);
    expect([201, 409]).toContain(codes[1]);
    expect((await readChart(enc)).body.data).toHaveLength(1);
  });
});

/* ── 5. …but a real second observation must still be possible ──────────────── */

describe("clinical duplicates are not duplicates", () => {
  /**
   * ── THE MOST IMPORTANT TEST IN THIS FILE ──────────────────────────────────
   * Idempotency protects ONE request repeated. It must never become "one reading per patient per
   * moment". A deteriorating patient is observed again ten minutes later — sometimes ten seconds
   * later — and a chart that refused the second reading would hide exactly the deterioration it
   * exists to show.
   *
   * There is deliberately NO unique index on this collection, and this is what says so.
   */
  it("charts a genuine second observation with the same values", async () => {
    const enc = await admit("Repeat Obs");
    await chart(enc, { pulse: 92 }).expect(201);
    await chart(enc, { pulse: 92 }).expect(201);
    expect((await readChart(enc)).body.data).toHaveLength(2);
  });

  it("charts a second observation from a different nurse in the same minute", async () => {
    const enc = await admit("Two Observers");
    await chart(enc, { pulse: 92 }).expect(201);
    await chart(enc, { pulse: 92 }, nurse2Token).expect(201);
    const list = (await readChart(enc)).body.data as { recordedBy: string }[];
    expect(list).toHaveLength(2);
    // Each carries its OWN observer. The chart must be able to say who took which reading.
    expect(new Set(list.map((r) => r.recordedBy)).size).toBe(2);
  });

  /** Different keys are different intents, and are both charted. */
  it("treats two distinct keys as two observations", async () => {
    const enc = await admit("Two Keys");
    await chart(enc, { pulse: 70 }, nurseToken, "vitals-distinct-a").expect(201);
    await chart(enc, { pulse: 70 }, nurseToken, "vitals-distinct-b").expect(201);
    expect((await readChart(enc)).body.data).toHaveLength(2);
  });

  it("returns the visit's readings oldest first — the order a chart is read in", async () => {
    const enc = await admit("Ordered Obs");
    await chart(enc, { pulse: 60 }).expect(201);
    await chart(enc, { pulse: 61 }).expect(201);
    const list = (await readChart(enc)).body.data as { pulse: number }[];
    expect(list.map((r) => r.pulse)).toEqual([60, 61]);
  });
});

/* ── 6. the boundaries ─────────────────────────────────────────────────────── */

describe("branch and tenant isolation", () => {
  /**
   * The write is scoped by the ENCOUNTER, resolved through `scopeFilter()`. A nurse bound to the
   * other site cannot reach this admission at all, so the answer is 404 rather than 403 — the
   * encounter genuinely does not exist for them, and saying "forbidden" would confirm it does.
   */
  it("refuses a nurse from another branch", async () => {
    const enc = await admit("Branch Guard");
    const res = await chart(enc, { pulse: 72 }, siteBNurseToken, undefined, siteB);
    expect(res.status).toBe(404);
    expect((await readChart(enc)).body.data).toHaveLength(0);
  });

  /**
   * The branch comes from the validated header, never from the body — so a caller cannot chart
   * INTO another site by naming it.
   */
  it("stamps the reading with the encounter's own branch", async () => {
    const enc = await admit("Branch Stamp");
    const res = await chart(enc, { pulse: 72 }).expect(201);
    expect(res.body.data.branchId).toBe(siteA);
    expect(res.body.data.branchId).not.toBe(siteB);
  });

  /**
   * Tenant isolation here is PHYSICAL — one database per hospital — so the rival's encounter id
   * is not merely filtered out, it is not in the database being queried at all.
   */
  it("refuses another hospital's encounter", async () => {
    const res = await chart(rivalEncounter, { pulse: 72 });
    expect(res.status).toBe(404);
  });

  /**
   * The read now answers 404, exactly as the write above does.
   *
   * It used to answer `200 []`, and both are safe — neither returns a rival row. But they are
   * different SENTENCES. `200 []` says "this visit exists and nobody has taken a reading",
   * which is a clinical claim, and a false one; 404 says "this visit is not yours", which is
   * the truth. On a chart, the first is the more dangerous thing to be wrong about.
   *
   * Changed by the D1 fix: `listForEncounter` resolves the encounter before reading, so GET and
   * POST on this URL can no longer disagree about whether the visit exists. The assertion that
   * matters — no rival data — is unchanged and still checked.
   */
  it("does not leak another hospital's readings on a read either", async () => {
    const res = await readChart(rivalEncounter);
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });
});

/* ── 7. time ───────────────────────────────────────────────────────────────── */

describe("timestamps", () => {
  /**
   * The wire format is UTC, always. Every zone decision — which day, which hour to show — happens
   * at the edge against the BRANCH's timezone, never against a device's.
   */
  it("returns recordedAt as an ISO instant in UTC", async () => {
    const enc = await admit("Stamp Obs");
    const res = await chart(enc, { pulse: 72 }).expect(201);
    expect(res.body.data.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("stamps it server-side when the client sends none", async () => {
    const enc = await admit("Server Stamp");
    const before = Date.now();
    const res = await chart(enc, { pulse: 72 }).expect(201);
    const at = Date.parse(res.body.data.recordedAt);
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  /** Back-dating is supported for a paper catch-up, and the value is honoured exactly. */
  it("honours an explicit past time for a paper catch-up", async () => {
    const enc = await admit("Backdated Obs");
    const when = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const res = await chart(enc, { pulse: 72, recordedAt: when }).expect(201);
    expect(res.body.data.recordedAt).toBe(when);
  });
});

/* ── 8. the ward worklist sees it ──────────────────────────────────────────── */

describe("worklist integration", () => {
  const worklist = () =>
    req("get", "/api/v1/ward-worklist?limit=50", nurseToken, main.host, siteA).expect(200);

  const rowFor = (body: { data: { encounterId: string }[] }, id: string) =>
    body.data.find((r) => r.encounterId === id);

  it("says plainly when a stay has no observations", async () => {
    const enc = await admit("No Obs Yet");
    const row = rowFor((await worklist()).body, enc);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ vitalsAbnormal: false });
    expect(row).not.toHaveProperty("latestVitalsAt");
  });

  /**
   * The row carries the SERVER's `abnormal`, computed by the same `assess()` the chart paints —
   * so the worklist and the chart can never disagree about the same reading.
   */
  it("carries the latest observation and the server's assessment of it", async () => {
    const enc = await admit("Worklist Obs");
    const saved = await chart(enc, { pulse: 130 }).expect(201);

    const row = rowFor((await worklist()).body, enc);
    expect(row).toMatchObject({ vitalsAbnormal: true, latestVitalsAt: saved.body.data.recordedAt });
  });

  it("tracks the NEWEST reading, not the first", async () => {
    const enc = await admit("Newest Obs");
    await chart(enc, { pulse: 130 }).expect(201);
    const later = await chart(enc, { pulse: 72 }).expect(201);

    const row = rowFor((await worklist()).body, enc);
    expect(row).toMatchObject({
      vitalsAbnormal: false,
      latestVitalsAt: later.body.data.recordedAt,
    });
  });

  /**
   * ── NO OBSERVATION SCHEDULE IS INVENTED ───────────────────────────────────
   * Nothing in the product records how often a patient should be observed, so the row states WHEN
   * and never whether that is late. A field called `vitalsOverdue` appearing here would be a
   * clinical protocol invented in a list endpoint.
   */
  it("never claims observations are overdue", async () => {
    const enc = await admit("No Schedule Invented");
    await chart(enc, { pulse: 72 }).expect(201);
    const row = rowFor((await worklist()).body, enc) as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("vitalsOverdue");
    expect(Object.keys(row)).not.toContain("vitalsDue");
  });
});
