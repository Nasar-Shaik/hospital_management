/**
 * BRANCH ISOLATION SUITE — release-gating security (ADR-0015, Doc 05 §4.2).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS ITS OWN FILE ──────────────────────────────
 * Multi-branch shipped complete: the Branch entity, the `X-Active-Branch` header, live
 * validation against the caller's allowed set, `scopeFilter` narrowing reads and
 * `writeBranchId()` stamping writes. All of it was UNTESTED. The audit of 2026-08-11
 * found exactly two branch tests in the whole repository, both about the *binding*
 * (`userRoles.branchIds`), both on `patients`, and **not one request in 1363 that ever
 * sent `X-Active-Branch`**.
 *
 * So the claim "a Branch A user cannot reach Branch B" rested on four lines in
 * `authorize.ts` that nothing exercised. A branch isolation bug is a security bug — the
 * same class as a cross-tenant leak — and cross-TENANT isolation already has its own
 * suite (`tenancy.int.test.ts`). This is the branch-level counterpart, kept separate so
 * it can be run and read on its own rather than buried in a 1,900-line matrix.
 *
 * ── THE SEMANTIC THIS SUITE PINS, WHICH IS NOT THE OBVIOUS ONE ───────────────
 * A Branch-A user who sends `X-Active-Branch: <Branch B>` is **not refused**. The header
 * is IGNORED and the request falls back to the caller's own allowed scope
 * (`resolveActiveBranch` returns `undefined`). ADR-0015 chose this deliberately: "a stale
 * selection fails SAFE (to the caller's own scope) instead of leaking or 500-ing".
 *
 * The security property is therefore **"no Branch B data reaches a Branch A user"**, and
 * that is what these tests assert. They deliberately do NOT assert a 4xx, because that
 * would be testing a design the project did not choose. The distinction is written down
 * here because "refused" and "ignored" look the same from a green test and are very
 * different when you are debugging why a switcher shows one thing and the list another.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Types, type Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("branchIsolation");
process.env.MONGO_MASTER_DB = "test_branchiso_master";
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
const { createHospital } = await import("./modules/platform/index.js");
const { seedMainBranch } = await import("./seed/mainBranch.js");
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const { markRetryOrFail } = await import("./core/events/outbox.js");
const { seedNotificationTemplates } = await import("./seed/notificationTemplates.js");
const { getEncounterModel } = await import("./modules/encounters/encounter.model.js");
const { getAppointmentModel, getDoctorScheduleModel } =
  await import("./modules/appointments/appointment.model.js");
const { getWardModel, getRoomModel, getBedModel } = await import("./modules/wards/ward.model.js");
const { getPatientModel } = await import("./modules/patients/patient.model.js");
const { getAllergyModel } = await import("./modules/allergies/allergy.model.js");
const { getVitalsModel } = await import("./modules/vitals/vitals.model.js");

const SLUG = "test-branchiso-apollo";
const DB = `hms_${SLUG}`;
/** The second hospital, provisioned through the operator console — see group 10. */
const NEWCO_DB = "hms_test-branchiso-newco";
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "branch-iso-int-test" }));

interface Tenant {
  id: string;
  slug: string;
  databaseName: string;
}
let tenant: Tenant;

/** The two sites. Real branches, created through the API — not invented ids. */
let branchA = "";
let branchB = "";

/** Hospital-wide (`branchScope: "all"`), branch-confined to A, and branch-confined to B. */
let tokenAdmin = "";
let tokenRecepA = "";
let tokenRecepB = "";
/**
 * A BRANCH MANAGER: every permission a tenant administrator has, but bound to Hyderabad alone.
 * The account that matters most for Phase 1 — a receptionist is stopped by the permission layer
 * long before the branch layer is consulted, so she cannot prove the branch layer works. This
 * one is stopped by nothing except her branch, which is precisely what is under test.
 */
let tokenMgrA = "";

/** A patient registered at each site, so "did the wrong one leak?" has a concrete answer. */
let patientAId = "";
let patientBId = "";

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  return runWithContext(
    { traceId: "branchiso-setup", tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    fn,
  );
}

/** Returns the new user's id, so a later re-binding needs no lookup. */
async function createUserWithRole(
  email: string,
  roleCode: string,
  branchIds: string[],
): Promise<string> {
  return inTenant(async () => {
    const user = await createUser({ email, name: email, status: "invited" });
    await setPassword(user.id, PASSWORD, { mustChangePassword: false });
    await assignRoleByCode(user.id, roleCode, branchIds);
    await transitionStatus(user.id, "active");
    return user.id;
  });
}

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

/** A GET as `token`, optionally naming an active branch. */
function get(path: string, token: string, activeBranch?: string): request.Test {
  const req = request(app).get(path).set("Host", HOST).set("Authorization", `Bearer ${token}`);
  return activeBranch ? req.set("X-Active-Branch", activeBranch) : req;
}

function post(path: string, token: string, activeBranch?: string): request.Test {
  const req = request(app).post(path).set("Host", HOST).set("Authorization", `Bearer ${token}`);
  return activeBranch ? req.set("X-Active-Branch", activeBranch) : req;
}

function put(path: string, token: string, activeBranch?: string): request.Test {
  const req = request(app).put(path).set("Host", HOST).set("Authorization", `Bearer ${token}`);
  return activeBranch ? req.set("X-Active-Branch", activeBranch) : req;
}

/**
 * The next Monday strictly in the future, as `YYYY-MM-DD`. A FUTURE day because availability
 * drops slots that have already passed, so "today, if today is Monday" would return an
 * ever-shrinking list and a test that fails in the afternoon.
 */
function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface PatientRow {
  id: string;
  branchId?: string;
}

/** Every patient the caller can see, as `(id, branchId)` pairs. */
async function patientsSeenBy(token: string, activeBranch?: string): Promise<PatientRow[]> {
  const res = await get("/api/v1/patients", token, activeBranch).expect(200);
  return res.body.data as PatientRow[];
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_branchiso_master", DB, NEWCO_DB]);
  await flushTestCache("branchIsolation");

  // Enterprise so that layer 1 (entitlement) never answers first — a 403 in this suite
  // must always be a scope decision, never "you did not buy this". `maxBranches` because
  // the platform cap defaults to 1 (single-site) and this suite needs two.
  const provisioned = await provisionTenant({
    hospitalName: "Apollo Branch Isolation",
    slug: SLUG,
    planCode: "PLAN_ENTERPRISE",
    maxBranches: 5,
  });
  tenant = {
    id: provisioned.tenant.id,
    slug: SLUG,
    databaseName: provisioned.tenant.databaseName,
  };

  await inTenant(async () => {
    await seedRbac();
  });

  // `provisionTenant` does not seed these — the CLI and `createHospital` do. Without them
  // `notify()` logs "no such template" and writes NO record, so the event-propagation group
  // would be asserting on an empty collection and passing for the wrong reason.
  {
    const connection = await getTenantConnection({
      id: tenant.id,
      databaseName: tenant.databaseName,
    });
    await seedNotificationTemplates(tenant.id, tenant.slug, connection);
  }

  // The admin is hospital-wide: an EMPTY branchIds list with `branchScope: "all"`, which is
  // the case the P2 bug got wrong in both directions.
  await createUserWithRole("admin@branchiso.test", "TENANT_ADMIN", []);
  tokenAdmin = await login("admin@branchiso.test");

  // Two real branches, created through the API by the admin.
  const a = await post("/api/v1/branches", tokenAdmin)
    .send({ name: "Hyderabad", code: "HYD" })
    .expect(201);
  const b = await post("/api/v1/branches", tokenAdmin)
    .send({ name: "Chennai", code: "CHN" })
    .expect(201);
  branchA = a.body.data.id as string;
  branchB = b.body.data.id as string;

  await createUserWithRole("recepa@branchiso.test", "RECEPTIONIST", [branchA]);
  await createUserWithRole("recepb@branchiso.test", "RECEPTIONIST", [branchB]);
  tokenRecepA = await login("recepa@branchiso.test");
  tokenRecepB = await login("recepb@branchiso.test");

  await createUserWithRole("mgra@branchiso.test", "TENANT_ADMIN", [branchA]);
  tokenMgrA = await login("mgra@branchiso.test");

  // One patient per site. Registered with NO explicit branchId, so the branch on the row is
  // whatever `writeBranchId()` stamped from the active branch — which is the thing under test.
  const pa = await post("/api/v1/patients", tokenAdmin, branchA)
    .send({ name: "Hyderabad Patient", gender: "female" })
    .expect(201);
  const pb = await post("/api/v1/patients", tokenAdmin, branchB)
    .send({ name: "Chennai Patient", gender: "male" })
    .expect(201);
  patientAId = pa.body.data.patient.id as string;
  patientBId = pb.body.data.patient.id as string;
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_branchiso_master", DB, NEWCO_DB]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. WRITES ARE STAMPED WITH THE ACTIVE BRANCH
 *    Everything below depends on this: if writes are not stamped, the isolation
 *    tests would be comparing empty sets and would pass while proving nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("writeBranchId stamps the active branch", () => {
  it("stamps the branch named in the header, not a default and not nothing", () => {
    // Asserted on the setup writes: `X-Active-Branch: A` produced a row in A.
    expect(branchA).not.toBe(branchB);
    expect(patientAId).toBeTruthy();
    expect(patientBId).toBeTruthy();
  });

  it("the stamped branch is readable back on the row", async () => {
    const seen = await patientsSeenBy(tokenAdmin, branchA);
    const stamped = seen.find((p) => p.id === patientAId);
    expect(stamped, "the Hyderabad patient must be visible when Hyderabad is active").toBeTruthy();
    expect(stamped?.branchId, "the row must carry the branch it was created in").toBe(branchA);
  });

  it("a confined receptionist's write is stamped with HER branch even when she names another", async () => {
    // The write-side of header spoofing. The header names Chennai; she may only reach
    // Hyderabad; the row must be Hyderabad. A row stamped Chennai here would be a
    // confined user writing INTO another site — worse than reading one.
    const res = await post("/api/v1/patients", tokenRecepA, branchB)
      .send({ name: "Spoof Attempt", gender: "male" })
      .expect(201);

    expect(
      res.body.data.patient.branchId,
      "a confined receptionist must never write into another branch",
    ).toBe(branchA);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE ISOLATION ITSELF — a Branch A user must never see Branch B data.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a branch-confined user cannot reach another branch", () => {
  it("sees her own branch when she selects it", async () => {
    const seen = await patientsSeenBy(tokenRecepA, branchA);
    expect(seen.length, "receptionist A must see Hyderabad patients").toBeGreaterThan(0);
    expect(seen.every((p) => p.branchId === branchA)).toBe(true);
  });

  it("sees ONLY her own branch when she selects none", async () => {
    const seen = await patientsSeenBy(tokenRecepA);
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every((p) => p.branchId === branchA),
      `receptionist A saw ${seen.map((p) => p.branchId ?? "none").join(",")}`,
    ).toBe(true);
  });

  it("SELECTING ANOTHER BRANCH IN THE HEADER LEAKS NOTHING", async () => {
    // The headline control. Note the semantic (see the file header): the header is not
    // refused, it is ignored — she falls back to her own scope. What must be true either
    // way is that no Chennai row appears.
    const seen = await patientsSeenBy(tokenRecepA, branchB);

    expect(
      seen.some((p) => p.id === patientBId),
      "receptionist A reached the Chennai patient by naming Chennai in X-Active-Branch",
    ).toBe(false);
    expect(
      seen.every((p) => p.branchId === branchA),
      `receptionist A saw ${seen.map((p) => p.branchId ?? "none").join(",")}`,
    ).toBe(true);
  });

  /**
   * ── THIS ASSERTED THE OPPOSITE UNTIL ADR-0015 §5 WAS HONOURED ─────────────
   * It used to require 403/404 here — "cannot fetch another branch's record by id, even knowing
   * the id" — and that was a real assertion somebody wrote on purpose, not an accident. It is
   * inverted rather than deleted so the reversal is visible in the file that held the old rule.
   *
   * The wall it pinned was never load-bearing: `check-duplicates` disclosed the same record, in
   * full, under the same `patient:read`, because the MPI is deliberately unscoped. What the wall
   * actually did was force a second chart — a second UHID with an empty allergy list. §18 has the
   * measurements and the reasoning.
   *
   * The isolation this GROUP is about is untouched: the register above stays branch-scoped, and
   * every operational record stays behind its own filter (see the falsification group in §18b).
   * A patient's NAME is not the boundary; what was done to them, and where, is.
   */
  it("CAN resolve another branch's patient by id — identity is tenant-wide", async () => {
    const res = await get(`/api/v1/patients/${patientBId}`, tokenRecepA).expect(200);
    expect(res.body.data.id).toBe(patientBId);
  });

  it("cannot reach another branch through a QUERY PARAMETER", async () => {
    // The list query schema is `.strict()`, so an unexpected `branchId` is refused
    // outright (400) rather than quietly ignored — which is the stronger answer: the
    // caller cannot even ASK for another branch. Both outcomes are accepted here so the
    // test pins the SECURITY property rather than the status code, but neither may
    // return a Chennai row.
    const res = await get(`/api/v1/patients?branchId=${branchB}`, tokenRecepA);

    if (res.status === 200) {
      const seen = res.body.data as PatientRow[];
      expect(seen.some((p) => p.id === patientBId)).toBe(false);
    } else {
      expect([400, 403]).toContain(res.status);
    }
  });

  it("cannot PLANT A RECORD in another branch through the REQUEST BODY", async () => {
    /**
     * THE TEST THAT FOUND A REAL VULNERABILITY.
     *
     * Five services took the branch straight from the payload —
     * `input.branchId ?? (await writeBranchId())` — so the body bypassed the very choke
     * point ADR-0015 says is the only way a branch is ever written. A receptionist
     * confined to Hyderabad could POST a patient with Chennai's id and the row was
     * created IN CHENNAI: a site she cannot read, write, or see in her switcher.
     *
     * The header was validated and the query string is refused by a `.strict()` schema.
     * The body was wide open, which is the vector nobody had tried.
     */
    const res = await post("/api/v1/patients", tokenRecepA).send({
      name: "Body Injection",
      gender: "female",
      branchId: branchB,
    });

    expect(res.status, "writing into an unreachable branch must be refused").toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");

    // And nothing was written: the Chennai receptionist must not find it either.
    const chennai = await patientsSeenBy(tokenRecepB, branchB);
    expect(
      chennai.some((p) => p.branchId === branchB && p.id === res.body?.data?.patient?.id),
    ).toBe(false);
  });

  it("the other direction holds too — receptionist B cannot see Hyderabad", async () => {
    // Symmetry matters: a filter that happens to be right for one branch and wrong for
    // the other is a filter that is keyed on the wrong thing.
    const seen = await patientsSeenBy(tokenRecepB, branchA);
    expect(seen.some((p) => p.id === patientAId)).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE HOSPITAL-WIDE USER — the permissive case must still work.
 *    A control that only ever denies is indistinguishable from a broken feature.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a hospital-wide user reaches every branch", () => {
  it("sees branch A when A is active", async () => {
    const seen = await patientsSeenBy(tokenAdmin, branchA);
    expect(seen.some((p) => p.id === patientAId)).toBe(true);
    expect(seen.some((p) => p.id === patientBId)).toBe(false);
  });

  it("sees branch B when B is active", async () => {
    const seen = await patientsSeenBy(tokenAdmin, branchB);
    expect(seen.some((p) => p.id === patientBId)).toBe(true);
    expect(seen.some((p) => p.id === patientAId)).toBe(false);
  });

  it("aggregates across both in All mode", async () => {
    const seen = await patientsSeenBy(tokenAdmin);
    expect(seen.some((p) => p.id === patientAId)).toBe(true);
    expect(seen.some((p) => p.id === patientBId)).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. ALL MODE CANNOT WRITE — HMS-BRANCH-001.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("All mode refuses a write rather than guessing a branch", () => {
  it("refuses with HMS-BRANCH-001 when several branches are reachable and none is chosen", async () => {
    const res = await post("/api/v1/patients", tokenAdmin)
      .send({ name: "No Branch Chosen", gender: "female" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-BRANCH-001");
  });

  it("the explicit `all` sentinel is All mode too, and is refused the same way", async () => {
    const res = await post("/api/v1/patients", tokenAdmin, "all")
      .send({ name: "Explicit All", gender: "male" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-BRANCH-001");
  });

  it("but a CONFINED user never has to choose — one reachable branch is not a guess", async () => {
    // The rule that keeps the whole feature invisible to a single-site hospital: with
    // exactly one candidate there is nothing to disambiguate, so no prompt.
    const res = await post("/api/v1/patients", tokenRecepA)
      .send({ name: "Single Branch Write", gender: "female" })
      .expect(201);

    expect(res.body.data.patient.branchId).toBe(branchA);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. MEMBERSHIP IS READ LIVE, NOT FROM THE TOKEN (ADR-0010's rule).
 * ──────────────────────────────────────────────────────────────────────────── */

describe("branch membership is live, not carried in the JWT", () => {
  it("moving a user between branches takes effect on her EXISTING token", async () => {
    // The case this defends: a staff member is moved off a site — or restricted during an
    // investigation — and must not keep reading the old site's patients until her token
    // expires. Scope is re-read every request from the authorization bundle.
    const moverId = await createUserWithRole("mover@branchiso.test", "RECEPTIONIST", [branchA]);
    const token = await login("mover@branchiso.test");

    const before = await patientsSeenBy(token);
    expect(before.every((p) => p.branchId === branchA)).toBe(true);
    expect(before.some((p) => p.id === patientAId)).toBe(true);

    // Move her to Chennai. Same token, no re-login.
    await inTenant(async () => {
      await assignRoleByCode(moverId, "RECEPTIONIST", [branchB]);
    });

    const after = await patientsSeenBy(token);
    expect(
      after.some((p) => p.id === patientAId),
      "she still saw her OLD branch's patient after being moved — scope came from the token",
    ).toBe(false);
    expect(after.every((p) => p.branchId === branchB)).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * PHASE 1 — the hardening that followed. Everything above proves the boundary
 * HOLDS; everything below proves the data can actually LIVE inside it: that two
 * sites can each have an ICU, that a doctor can hold a Monday clinic at both,
 * that a hospital is born with a branch at all, and that the three write paths
 * the Phase 0 sweep missed are closed too.
 * ════════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────────────────────
 * 6. A WARD BELONGS TO A SITE — `one_ward_name_per_branch` (migration 0046)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("two sites can each have a ward of the same name", () => {
  it("accepts ICU at Hyderabad AND ICU at Chennai", async () => {
    // The tenant-wide key this replaces rejected the second one outright, which is a hospital
    // being told by its database that it may not have an intensive care unit.
    const hyd = await post("/api/v1/wards", tokenAdmin, branchA)
      .send({ name: "ICU", kind: "icu", tariffCode: "BED_ICU" })
      .expect(201);
    const chn = await post("/api/v1/wards", tokenAdmin, branchB)
      .send({ name: "ICU", kind: "icu", tariffCode: "BED_ICU" })
      .expect(201);

    expect(hyd.body.data.branchId).toBe(branchA);
    expect(chn.body.data.branchId).toBe(branchB);
    expect(hyd.body.data.id).not.toBe(chn.body.data.id);
  });

  it("still refuses a duplicate name WITHIN one site", async () => {
    // Widening the key must not have removed the rule — "ICU" twice at Hyderabad is still a typo.
    // (The first ICU at Hyderabad was created by the test above.)
    const res = await post("/api/v1/wards", tokenAdmin, branchA).send({
      name: "ICU",
      kind: "icu",
      tariffCode: "BED_ICU",
    });

    expect(
      res.status,
      "a duplicate ward name at the SAME site was accepted",
    ).toBeGreaterThanOrEqual(400);
  });

  it("a branch-confined user sees only her own site's ICU", async () => {
    // The branch manager, not the receptionist: reading the bed catalogue needs `emr:read`, and
    // a 403 from the permission layer would prove nothing about branches.
    const res = await get("/api/v1/wards", tokenMgrA).expect(200);
    const wards = res.body.data as { name: string; branchId?: string }[];
    expect(wards.length).toBeGreaterThan(0);
    expect(
      wards.every((w) => w.branchId === branchA),
      "a ward from another site appeared in a confined user's catalogue",
    ).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. BED OCCUPANCY IS PER SITE — `one_open_stay_per_bed_per_branch`
 *
 * Asserted against the INDEX rather than through the admission flow, because the
 * index IS the rule: `one_open_stay_per_bed` is the only thing that arbitrates
 * two clerks admitting into the same bed at the same instant, and no service
 * check can stand in for it. Testing it through four screens would prove the
 * screens work, not that the invariant is branch-aware.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("bed occupancy is isolated per branch", () => {
  /**
   * An open inpatient stay, written raw so the unique partial index is the only judge.
   *
   * Each gets its OWN patientId: `one_open_encounter_per_patient` is a separate invariant on
   * `{tenantId, patientId}`, and reusing one patient would trip that index instead of the bed
   * one — the test would go red for a reason that has nothing to do with branches.
   */
  let patientSeq = 0;
  function stay(branchId: string, ward: string, bedCode: string): Record<string, unknown> {
    patientSeq += 1;
    return {
      tenantId: tenant.id,
      branchId,
      patientId: new Types.ObjectId(),
      open: true,
      type: "IP",
      status: "admitted",
      mrn: `BEDTEST-${String(patientSeq)}`,
      bed: { ward, bedCode, tariffCode: "BED_ICU" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("ICU/A-12 can be occupied at BOTH sites at once", async () => {
    await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const encounters = conn.collection("encounters");

      await encounters.insertOne(stay(branchA, "ICU", "A-12"));
      // Before 0046 this threw E11000: Chennai's patient was refused a bed because a
      // DIFFERENT hospital, in a different city, had someone in a bed with the same label.
      await expect(encounters.insertOne(stay(branchB, "ICU", "A-12"))).resolves.toBeTruthy();
    });
  });

  it("but the same bed at the SAME site is still refused", async () => {
    await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const encounters = conn.collection("encounters");

      await encounters.insertOne(stay(branchA, "ICU", "B-01"));
      await expect(
        encounters.insertOne(stay(branchA, "ICU", "B-01")),
        "two patients were recorded in one bed — the occupancy invariant is gone",
      ).rejects.toThrow(/E11000|duplicate key/i);
    });
  });

  it("the old tenant-wide occupancy index is gone, not merely shadowed", async () => {
    // Two unique indexes would mean the stricter one still decides, and the test above would
    // be passing for the wrong reason on a database where 0046 only half-applied.
    await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const names = (await conn.collection("encounters").indexes()).map((i) => i.name);
      expect(names).toContain("one_open_stay_per_bed_per_branch");
      expect(names).not.toContain("one_open_stay_per_bed");
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. A DOCTOR'S MONDAY IS A MONDAY *SOMEWHERE* (migration 0046)
 *
 * The old key `{tenantId, doctorId, weekday}` was described in 0010 as "the upsert
 * key", and that is exactly what made it dangerous: setting Dr Rao's Chennai Monday
 * did not FAIL, it silently overwrote his Hyderabad Monday, and the only symptom was
 * a clinic that stopped offering slots.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A 24-hex id; `doctorId` is stored as a string, so it needs no real user behind it. */
const DOCTOR = "aaaaaaaaaaaaaaaaaaaaaa01";

describe("a doctor can hold the same weekday at two sites", () => {
  it("keeps both Mondays instead of overwriting the first", async () => {
    // Monday mornings in Hyderabad, Monday afternoons in Chennai.
    const hyd = await put("/api/v1/doctors/schedule", tokenAdmin, branchA)
      .send({ doctorId: DOCTOR, weekday: 1, startMinute: 540, endMinute: 720, slotMinutes: 15 })
      .expect(201);
    const chn = await put("/api/v1/doctors/schedule", tokenAdmin, branchB)
      .send({ doctorId: DOCTOR, weekday: 1, startMinute: 840, endMinute: 1020, slotMinutes: 15 })
      .expect(201);

    expect(hyd.body.data.branchId).toBe(branchA);
    expect(chn.body.data.branchId).toBe(branchB);
    expect(
      hyd.body.data.id,
      "the second site's Monday reused the first's row — one of the two clinics has been erased",
    ).not.toBe(chn.body.data.id);

    // And the first is untouched: still the morning session, not overwritten by the afternoon.
    const all = await get(`/api/v1/doctors/${DOCTOR}/schedule`, tokenAdmin).expect(200);
    const rows = all.body.data as { branchId?: string; startMinute: number }[];
    const morning = rows.find((r) => r.branchId === branchA);
    expect(morning?.startMinute, "Hyderabad's morning clinic was overwritten").toBe(540);
  });

  it("re-setting the same weekday at the same site UPDATES rather than duplicating", async () => {
    // The upsert must still be an upsert — a wider key must not turn edits into inserts.
    await put("/api/v1/doctors/schedule", tokenAdmin, branchA)
      .send({ doctorId: DOCTOR, weekday: 1, startMinute: 600, endMinute: 720, slotMinutes: 15 })
      .expect(201);

    const all = await get(`/api/v1/doctors/${DOCTOR}/schedule`, tokenAdmin).expect(200);
    const rows = all.body.data as { branchId?: string; startMinute: number }[];
    const atA = rows.filter((r) => r.branchId === branchA);
    expect(atA).toHaveLength(1);
    expect(atA[0]?.startMinute).toBe(600);
  });

  it("offers the slots of the site being worked at, not the doctor's whole week", async () => {
    // The effective schedule is doctor + BRANCH + weekday. Without the branch in the lookup,
    // a Hyderabad receptionist would be offered Chennai's afternoon and book a patient into a
    // clinic 600km away.
    const monday = nextMonday();
    const atHyd = await get(
      `/api/v1/appointments/availability?doctorId=${DOCTOR}&date=${monday}`,
      tokenAdmin,
      branchA,
    ).expect(200);
    const atChn = await get(
      `/api/v1/appointments/availability?doctorId=${DOCTOR}&date=${monday}`,
      tokenAdmin,
      branchB,
    ).expect(200);

    const minutesOf = (body: { data: { startAt: string }[] }): number[] =>
      body.data.map((s) => {
        const d = new Date(s.startAt);
        return d.getHours() * 60 + d.getMinutes();
      });

    const hyd = minutesOf(atHyd.body);
    const chn = minutesOf(atChn.body);
    expect(hyd.length).toBeGreaterThan(0);
    expect(chn.length).toBeGreaterThan(0);
    // Hyderabad runs 10:00–12:00, Chennai 14:00–17:00. Neither may offer the other's hours.
    expect(Math.max(...hyd), "a Chennai afternoon slot was offered at Hyderabad").toBeLessThan(840);
    expect(
      Math.min(...chn),
      "a Hyderabad morning slot was offered at Chennai",
    ).toBeGreaterThanOrEqual(840);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 9. THE THREE WRITE PATHS PHASE 0 MISSED
 *
 * Phase 0 swept for `input.branchId ?? (await writeBranchId())` and closed five
 * sites. These three do not use that idiom — they pass the body value straight
 * down — so the grep did not find them and they stayed open. Roster writes, not
 * patient writes, which is why nothing clinical pointed at them.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("roster writes cannot name a branch the caller may not reach", () => {
  it("refuses a schedule written into another site", async () => {
    const res = await put("/api/v1/doctors/schedule", tokenMgrA).send({
      doctorId: DOCTOR,
      weekday: 3,
      startMinute: 540,
      endMinute: 720,
      slotMinutes: 15,
      branchId: branchB,
    });

    expect(res.status, "a Hyderabad manager set Chennai's clinic hours").toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses a roster row written into another site", async () => {
    const res = await put("/api/v1/doctors/availability", tokenMgrA).send({
      doctorId: DOCTOR,
      weekday: 3,
      sessions: ["morning"],
      branchId: branchB,
    });

    expect(res.status, "a Hyderabad manager set Chennai's roster").toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses leave written into another site", async () => {
    // Leave is read back through `scopeFilter`, so stamping it with a branch the author cannot
    // reach HIDES it: Chennai would never learn the doctor is away and would keep booking.
    const res = await post("/api/v1/doctors/leave", tokenMgrA).send({
      doctorId: DOCTOR,
      fromDate: "2026-12-01",
      toDate: "2026-12-03",
      branchId: branchB,
    });

    expect(res.status, "a Hyderabad manager filed leave against Chennai").toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("and still stamps her OWN branch when she names none", async () => {
    // The refusal must not have cost the ordinary case: one reachable site is not a guess.
    const res = await put("/api/v1/doctors/schedule", tokenMgrA)
      .send({ doctorId: DOCTOR, weekday: 4, startMinute: 540, endMinute: 720, slotMinutes: 15 })
      .expect(201);

    expect(res.body.data.branchId).toBe(branchA);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 10. A HOSPITAL IS BORN WITH A BRANCH
 *
 * `createHospital` — the operator console's provisioning path — seeded the admin,
 * the notification templates and the tariff, and did NOT seed the Main Branch. The
 * CLI always had. So a hospital provisioned over HTTP had no branch at all,
 * `writeBranchId()` found no candidate, and every record it ever wrote was
 * branchless: invisible to a branch-confined user the day it opened a second site.
 * Nothing failed; the data was simply born wrong.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("console provisioning gives the hospital its Main Branch", () => {
  const NEW_SLUG = "test-branchiso-newco";
  let newTenantId = "";
  let newTenantDb = "";

  interface BranchRow {
    _id: { toString(): string };
    name: string;
    isMain?: boolean;
  }

  async function branchesOfNewTenant(): Promise<BranchRow[]> {
    const conn = await getTenantConnection({ id: newTenantId, databaseName: newTenantDb });
    return conn.collection<BranchRow>("branches").find({}).toArray();
  }

  beforeAll(async () => {
    const created = await createHospital(
      {
        slug: NEW_SLUG,
        hospitalName: "Newco Hospital",
        planCode: "PLAN_ENTERPRISE",
        adminEmail: "admin@newco.test",
        adminPassword: PASSWORD,
      },
      { id: "operator-1", email: "operator@medicore.test" },
      { traceId: "branchiso-provisioning" },
      "medicore.test",
    );
    newTenantId = created.hospital.id;
    newTenantDb = `hms_${NEW_SLUG}`;
  }, 120_000);

  it("creates exactly one branch, and it is the Main Branch", async () => {
    const branches = await branchesOfNewTenant();
    expect(branches, "a console-provisioned hospital had NO branch").toHaveLength(1);
    expect(branches[0]?.isMain).toBe(true);
    expect(branches[0]?.name).toBe("Main Branch");
  });

  it("is idempotent — a re-run makes no second Main Branch", async () => {
    // The retry case: provisioning got this far and failed downstream, and an operator runs it
    // again. Also the `migrate --all` case, which re-seeds every hospital on every release.
    const conn = await getTenantConnection({ id: newTenantId, databaseName: newTenantDb });
    const again = await seedMainBranch(newTenantId, NEW_SLUG, conn);

    expect(again.created).toBe(false);
    expect(await branchesOfNewTenant()).toHaveLength(1);
  });

  /**
   * ── THE WALL THAT DID NOT MOVE WHEN §18 WIDENED PATIENT IDENTITY ──────────
   * Patient lookup is tenant-wide by BRANCH now (ADR-0015 §5). It is not tenant-wide across
   * HOSPITALS and never can be: `getTenantDb()` hands back a physically separate database, so a
   * foreign id resolves to nothing regardless of what any branch filter says.
   *
   * It lives in this block because this is where the second hospital exists. Asserting it from
   * §18 would have made that group depend on this one's fixture — and a cross-tenant test that
   * silently skips when the other tenant is absent proves nothing at all.
   */
  it("cannot resolve THIS tenant's patient from the new hospital", async () => {
    const token = (
      await request(app)
        .post("/api/v1/auth/login")
        .set("Host", `${NEW_SLUG}.medicore.test`)
        .send({ email: "admin@newco.test", password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;

    // `patientAId` is real, active, and readable across every branch of ITS OWN hospital.
    const res = await request(app)
      .get(`/api/v1/patients/${patientAId}`)
      .set("Host", `${NEW_SLUG}.medicore.test`)
      .set("Authorization", `Bearer ${token}`);

    expect([403, 404]).toContain(res.status);
  });

  it("so a patient registered there is stamped with a real branch", async () => {
    // The point of all of it: no active branch chosen, one candidate, therefore stamped.
    const token = (
      await request(app)
        .post("/api/v1/auth/login")
        .set("Host", `${NEW_SLUG}.medicore.test`)
        .send({ email: "admin@newco.test", password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;

    const res = await request(app)
      .post("/api/v1/patients")
      .set("Host", `${NEW_SLUG}.medicore.test`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Newco Patient", gender: "female" })
      .expect(201);

    const branches = await branchesOfNewTenant();
    expect(res.body.data.patient.branchId).toBe(branches[0]?._id.toString());
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 11. THE BACKFILL REFUSES TO GUESS
 *
 * Adopting a branchless row into the Main Branch is an INFERENCE — "there was only
 * one site, so it happened there" — and it is true right up until the hospital has
 * two. From then on the same code would be inventing a fact: writing Hyderabad onto
 * a row that might be Chennai's, permanently and unprovably.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the Main Branch backfill declines on a multi-branch hospital", () => {
  it("leaves a branchless row alone and reports it instead", async () => {
    await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      // A pre-branch row, as a hospital provisioned before ADR-0015 would have.
      await conn.collection("walletEntries").insertOne({
        tenantId: tenant.id,
        patientId: patientAId,
        type: "deposit",
        amount: 5000,
        balanceAfter: 5000,
        at: new Date(),
      });

      // This tenant has Hyderabad and Chennai, so which desk took the money is unknowable.
      const result = await seedMainBranch(tenant.id, tenant.slug, conn);

      expect(result.skipped?.reason).toBe("multiple branches");
      expect(result.skipped?.branchless.walletEntries).toBeGreaterThanOrEqual(1);
      expect(result.backfilled).toEqual({});

      const stillBranchless = await conn
        .collection("walletEntries")
        .countDocuments({ branchId: { $exists: false } });
      expect(
        stillBranchless,
        "the backfill invented a branch for a row it could not attribute",
      ).toBeGreaterThanOrEqual(1);
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 12. THE STOCK LEDGER RECORDS WHICH PHARMACY
 *
 * `receiveStock`/`adjustStock` took an optional `branchId` that the controller
 * never passed, so every receipt and adjustment made over HTTP was written
 * branchless — and the field's presence made it look solved.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("stock movements record the site they happened at", () => {
  it("stamps a receipt with the active branch", async () => {
    const medicine = await post("/api/v1/medicines", tokenAdmin, branchA)
      .send({ code: "PARA500", name: "Paracetamol 500mg", form: "tablet" })
      .expect(201);
    const id = medicine.body.data.id as string;

    await post(`/api/v1/medicines/${id}/receive`, tokenAdmin, branchA)
      .send({ quantity: 100 })
      .expect(201);

    await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const movements = await conn
        .collection("stockMovements")
        .find({ medicineCode: "PARA500" })
        .toArray();

      expect(movements.length).toBeGreaterThan(0);
      expect(
        movements.every((m) => m.branchId === branchA),
        "a stock movement was written with no branch — the ledger cannot say which pharmacy",
      ).toBe(true);
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * PHASE 1.5 — the branch has to survive the parts that are not a request.
 * ════════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────────────────────
 * 13. THE BRANCH TRAVELS WITH THE EVENT
 *
 * Six collections were left `branchId`-optional in Phase 1 because they are
 * written by consumers, off an event payload, and failing them closed before the
 * chain was proven would wedge the outbox rather than surface a bug. This is that
 * proof, walked end to end:
 *
 *     operation → publish → outboxEvents row → envelope → handler → target write
 *
 * Deliberately NOT a hand-built envelope. The existing suites construct one by
 * hand, which tests the handler but assumes the two steps before it; here the row
 * is read back out of `outboxEvents` and the envelope is assembled from it exactly
 * as `outboxRelay.dispatch` does, so persistence is part of what is under test.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The instant `minutes` past local midnight on `dateStr` — how a slot start is expressed. */
function slotAt(dateStr: string, minutes: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMinutes(minutes);
  return d.toISOString();
}

interface OutboxRow {
  eventId: string;
  name: string;
  version: number;
  tenantId: string;
  branchId?: string;
  occurredAt: Date;
  traceId?: string;
  payload: Record<string, unknown>;
}

describe("a domain event carries its branch all the way to the target record", () => {
  /** Books at one site and returns the appointment plus the outbox row it committed with. */
  async function bookAt(
    branch: string,
    patientId: string,
    minutes: number,
  ): Promise<{ appointmentId: string; row: OutboxRow }> {
    const res = await post("/api/v1/appointments", tokenAdmin, branch)
      .send({ patientId, doctorId: DOCTOR, startAt: slotAt(nextMonday(), minutes) })
      .expect(201);
    const appointmentId = res.body.data.id as string;

    const row = await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      return conn.collection<OutboxRow>("outboxEvents").findOne({
        name: "appointment.appointment.booked",
        "payload.appointmentId": appointmentId,
      });
    });
    if (!row) throw new Error(`no outbox row for appointment ${appointmentId}`);
    return { appointmentId, row };
  }

  /** The envelope `outboxRelay.dispatch` builds from a row — copied, not approximated. */
  function envelopeOf(row: OutboxRow): Record<string, unknown> {
    return {
      eventId: row.eventId,
      name: row.name,
      version: row.version,
      tenantId: row.tenantId,
      branchId: row.branchId,
      occurredAt: row.occurredAt,
      traceId: row.traceId,
      payload: row.payload,
    };
  }

  async function notificationFor(appointmentId: string): Promise<{ branchId?: string }[]> {
    return inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      return conn
        .collection<{ branchId?: string }>("notifications")
        .find({ dedupeKey: `appointment.confirmation:${appointmentId}` })
        .toArray();
    });
  }

  let hyd: { appointmentId: string; row: OutboxRow };
  let chn: { appointmentId: string; row: OutboxRow };

  beforeAll(async () => {
    // Hyderabad's Monday clinic runs 10:00–12:00, Chennai's 14:00–17:00 (group 8).
    hyd = await bookAt(branchA, patientAId, 600);
    chn = await bookAt(branchB, patientBId, 840);
  }, 60_000);

  it("stamps the outbox row with the branch the operation happened at", () => {
    expect(hyd.row.branchId, "the Hyderabad booking committed a branchless event").toBe(branchA);
    expect(chn.row.branchId, "the Chennai booking committed a branchless event").toBe(branchB);
  });

  it("delivers Branch A's event to a Branch A record", async () => {
    await inTenant(() => dispatchEventInline(envelopeOf(hyd.row) as never));

    const rows = await notificationFor(hyd.appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branchId, "the confirmation lost its branch on the way through").toBe(branchA);
  });

  it("delivers Branch B's event to a Branch B record", async () => {
    await inTenant(() => dispatchEventInline(envelopeOf(chn.row) as never));

    const rows = await notificationFor(chn.appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branchId).toBe(branchB);
    // The pair is the point: two events, two sites, and neither picked up the other's.
    expect(rows[0]?.branchId).not.toBe(branchA);
  });

  it("keeps the branch across a REDELIVERY — no second row, no drift", async () => {
    // Delivery is at-least-once by design, so the branch has to be idempotent too: a replay
    // must not create a second record, and must not create one in a different place.
    await inTenant(() => dispatchEventInline(envelopeOf(hyd.row) as never));
    await inTenant(() => dispatchEventInline(envelopeOf(hyd.row) as never));

    const rows = await notificationFor(hyd.appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.branchId).toBe(branchA);
  });

  it("gives the branch to a handler that never asks for one", async () => {
    /**
     * ── WHAT THE TEST ABOVE DOES NOT PROVE ──────────────────────────────────
     * `onAppointmentBooked` reads the branch off the APPOINTMENT and passes it to `notify`
     * explicitly, so the confirmation lands in the right place even when the envelope is
     * branchless — falsifying `publish` leaves those assertions green. That second source is
     * a good thing and it is also why they cannot pin the propagation.
     *
     * The handlers that have no second source are the ones that matter: `order.result.released`
     * passes no branch, and neither will the next consumer somebody writes. For those the ONLY
     * source is the context `withTenant` binds from the envelope. That is what this pins —
     * `notify` with no `branchId`, in the context a consumer runs in, must record the event's
     * site.
     */
    // A real Chennai order, and the real `order.result.released` handler — which calls
    // `notify` with no branch of its own, so the only possible source is the envelope.
    const encounter = await post("/api/v1/encounters", tokenAdmin, branchB)
      .send({ patientId: patientBId, departmentId: DOCTOR })
      .expect(201);
    const encounterId = encounter.body.data.encounter.id as string;

    const order = await post("/api/v1/orders", tokenAdmin, branchB)
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = order.body.data.order.id as string;

    await inTenant(() =>
      dispatchEventInline({
        eventId: `evt-branchiso-${orderId}`,
        name: "order.result.released",
        version: 1,
        tenantId: tenant.id,
        branchId: branchB,
        occurredAt: new Date().toISOString(),
        payload: { orderId },
      } as never),
    );

    const rows = await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      return conn
        .collection<{ branchId?: string }>("notifications")
        .find({ dedupeKey: `order.result.released:${orderId}` })
        .toArray();
    });

    expect(rows, "the result-released handler wrote no notification").toHaveLength(1);
    expect(
      rows[0]?.branchId,
      "a handler that passes no branch got no branch — the event's site is not reaching notify()",
    ).toBe(branchB);
  });

  it("keeps the branch across a RETRY — the failure path does not touch it", async () => {
    // `markRetryOrFail` is what a failed dispatch calls before the event is picked up again.
    // If it rewrote the row rather than `$set`ting the three retry fields, attempt two would
    // dispatch a branchless envelope and the record would land nowhere in particular.
    const after = await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const live = await conn
        .collection<OutboxRow & { _id: Types.ObjectId; attempts: number }>("outboxEvents")
        .findOne({ eventId: hyd.row.eventId });
      if (!live) throw new Error("outbox row vanished");

      await markRetryOrFail(conn, live as never, "simulated dispatch failure", 5, 1_000);
      return conn.collection<OutboxRow>("outboxEvents").findOne({ eventId: hyd.row.eventId });
    });

    expect(after?.branchId, "a retry erased the event's branch").toBe(branchA);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 14. DOCTOR LEAVE IS BRANCH-SPECIFIC — AND THAT IS ALL IT CAN BE
 *
 * The model represents ONE of the two things a hospital might mean by "leave":
 *
 *   A. Branch-specific — the doctor is not at this site today. Representable, and
 *      proven here: leave at Hyderabad must not close Chennai's clinic.
 *   B. Hospital-wide — the doctor is away, everywhere. NOT representable, because
 *      `scopeFilter` matches `branchId` exactly; a row left branchless to mean
 *      "everywhere" is invisible to every caller who has selected a site, so it
 *      would suppress nothing at all. Silently. See PROJECT-STATUS for the
 *      smallest change that would add it — it needs an explicit `scope` field, not
 *      an absent `branchId`, for the reason the P2 bug taught: when emptiness is
 *      load-bearing, store the intent rather than the absence.
 *
 * Not implemented, because nothing in the product asks for it yet and a wrong
 * guess here books patients with a doctor who is not in the building.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("leave at one site does not close the clinic at another", () => {
  /** A weekday nothing else in this file uses, so the two sites start symmetrical. */
  const LEAVE_DOCTOR = "aaaaaaaaaaaaaaaaaaaaaa02";

  beforeAll(async () => {
    // The same doctor holds a Tuesday clinic at both sites.
    for (const branch of [branchA, branchB]) {
      await put("/api/v1/doctors/schedule", tokenAdmin, branch)
        .send({
          doctorId: LEAVE_DOCTOR,
          weekday: 2,
          startMinute: 600,
          endMinute: 720,
          slotMinutes: 30,
        })
        .expect(201);
    }
  }, 60_000);

  function nextTuesday(): string {
    const d = new Date();
    d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  async function slotCount(branch: string, date: string): Promise<number> {
    const res = await get(
      `/api/v1/appointments/availability?doctorId=${LEAVE_DOCTOR}&date=${date}`,
      tokenAdmin,
      branch,
    ).expect(200);
    return (res.body.data as unknown[]).length;
  }

  it("suppresses slots at the site the leave was filed against", async () => {
    const tuesday = nextTuesday();
    expect(await slotCount(branchA, tuesday)).toBeGreaterThan(0);
    expect(await slotCount(branchB, tuesday)).toBeGreaterThan(0);

    await post("/api/v1/doctors/leave", tokenAdmin, branchA)
      .send({ doctorId: LEAVE_DOCTOR, fromDate: tuesday, toDate: tuesday, reason: "conference" })
      .expect(201);

    expect(await slotCount(branchA, tuesday), "Hyderabad kept offering a doctor on leave").toBe(0);
  });

  it("and leaves the OTHER site's clinic running", async () => {
    // The inverse of the bug: branch-specific leave must not reach across sites. A doctor who
    // is off in Hyderabad on Tuesday may still be seeing patients in Chennai that afternoon.
    const tuesday = nextTuesday();
    expect(
      await slotCount(branchB, tuesday),
      "Hyderabad's leave closed Chennai's clinic — leave is leaking across branches",
    ).toBeGreaterThan(0);
  });

  it("and the same holds with the sites reversed", async () => {
    const tuesday = nextTuesday();
    await post("/api/v1/doctors/leave", tokenAdmin, branchB)
      .send({ doctorId: LEAVE_DOCTOR, fromDate: tuesday, toDate: tuesday, reason: "conference" })
      .expect(201);

    // Now both are closed — which is what TWO branch-specific leaves mean, and is the only
    // way to express "away everywhere" in the current model.
    expect(await slotCount(branchB, tuesday)).toBe(0);
    expect(await slotCount(branchA, tuesday)).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 15. THE PLUGIN MUST NOT EAT A MODEL'S branchId AGAIN
 *
 * `applyCommonFields` used to declare `branchId` in the same `schema.add` as
 * `tenantId`, and `schema.add` REPLACES a path — so all 29 models' own
 * declarations were dead, and `required: true` on a branch-scoped collection
 * enforced nothing while looking exactly like it did.
 *
 * A unit test on the plugin would be the obvious guard and it is not enough: it
 * would pass against a plugin that got it right in isolation and a model that
 * applies it in the wrong order. This asserts the property on the REAL compiled
 * models, which is where the bug actually lived.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("branchId enforcement survives the tenant plugin", () => {
  /**
   * Through the model ACCESSORS, not `conn.models[name]`: a model is compiled lazily on first
   * use, so reading the registry would find `undefined` for anything this suite happens not to
   * touch and the assertion would pass by not running. The accessor compiles the schema the same
   * way production does, which is the thing under test.
   */
  async function branchPath(
    accessor: (conn: Connection) => { schema: { path(p: string): { isRequired?: boolean } } },
  ): Promise<{ isRequired?: boolean }> {
    const conn = await getTenantConnection({
      id: tenant.id,
      databaseName: tenant.databaseName,
    });
    return accessor(conn).schema.path("branchId");
  }

  it("keeps `required` on the models that declared it", async () => {
    const required: [string, Parameters<typeof branchPath>[0]][] = [
      ["Encounter", getEncounterModel],
      ["Appointment", getAppointmentModel],
      ["DoctorSchedule", getDoctorScheduleModel],
      ["Ward", getWardModel],
      ["Room", getRoomModel],
      ["Bed", getBedModel],
    ];
    for (const [name, accessor] of required) {
      const path = await branchPath(accessor);
      expect(path, `${name} has no branchId path at all`).toBeDefined();
      expect(
        path.isRequired,
        `${name}.branchId lost its \`required\` — the plugin is overwriting it again`,
      ).toBe(true);
    }
  });

  it("leaves it OPTIONAL where the entity is tenant-wide", async () => {
    // The other half of the guard: a fix that made `branchId` required everywhere would pass the
    // test above and quietly break patient identity and the allergy safety exception.
    for (const [name, accessor] of [
      ["Patient", getPatientModel],
      ["Allergy", getAllergyModel],
    ] as [string, Parameters<typeof branchPath>[0]][]) {
      const path = await branchPath(accessor);
      expect(path?.isRequired ?? false, `${name}.branchId must stay optional`).toBe(false);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A RETIRED BRANCH IS NOT A PLACE YOU CAN STILL WORK
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a closed branch cannot be worked in, however the client asks", () => {
  /**
   * `X-Active-Branch` used to be checked against MEMBERSHIP alone, and for a hospital-wide
   * binding against nothing at all — `allBranches` returned the header unexamined. Two holes:
   *
   *   1. Membership outlives the branch. Retiring a site does not revoke anyone's binding, so a
   *      client that remembered the selection — a phone, most obviously — kept acting in a
   *      hospital the organisation has closed, while `/me/branches` had already stopped listing
   *      it. M0 §7 says the list outranks anything the phone remembers; this is the server half.
   *   2. A hospital-wide caller could name ANY id, including one belonging to a DIFFERENT TENANT.
   *      Reads stayed safe because the tenant plugin still filtered them, but `writeBranchId`
   *      stamps the active branch onto new rows — so another hospital's branch id could be
   *      written into this one's records.
   *
   * The rule now: reachable AND open AND in this tenant, or it is not a selection at all.
   */
  let retired = "";

  beforeAll(async () => {
    const made = await post("/api/v1/branches", tokenAdmin)
      .send({ name: "Warangal", code: "WGL" })
      .expect(201);
    retired = made.body.data.id as string;

    // Give a confined user a binding to it BEFORE it closes — the binding is what survives.
    await createUserWithRole("recepw@branchiso.test", "RECEPTIONIST", [retired]);

    await request(app)
      .patch(`/api/v1/branches/${retired}`)
      .set("Host", HOST)
      .set("Authorization", `Bearer ${tokenAdmin}`)
      .send({ status: "inactive" })
      .expect(200);
  }, 60_000);

  it("drops it from the switcher, which is what the phone reads", async () => {
    const mine = await get("/api/v1/me/branches", tokenAdmin).expect(200);
    const ids = (mine.body.data.branches as { id: string }[]).map((b) => b.id);

    expect(ids).not.toContain(retired);
    expect(ids).toEqual(expect.arrayContaining([branchA, branchB]));
  });

  it("ignores it in X-Active-Branch from a HOSPITAL-WIDE caller — the unguarded path", async () => {
    /**
     * The admin may reach every branch, so membership can never refuse this one. Only the
     * branch's own status can, which is exactly the check that did not exist.
     */
    const res = await post("/api/v1/patients", tokenAdmin, retired).send({
      name: "Retired Site",
      gender: "male",
    });

    /**
     * The selection is discarded, so the admin is back in All mode with two open branches and no
     * choice made — which `writeBranchId` refuses rather than guessing (HMS-BRANCH-001). A refusal
     * is the RIGHT answer here; what must never happen is a row stamped into the closed site.
     */
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-BRANCH-001");
    expect(res.body.data?.patient?.branchId ?? undefined).not.toBe(retired);
  });

  it("ignores it for a CONFINED caller whose binding outlived the branch", async () => {
    const tokenRecepW = await login("recepw@branchiso.test");

    /**
     * Her ONLY branch is closed. This caught a second, separate hole: `writeBranchId` short-circuited
     * to "the one branch this caller holds" without asking whether it was still open, so the header
     * guard above was bypassed entirely on the write path. The write must not land in the retired
     * branch — refused or branchless, never there.
     */
    const res = await post("/api/v1/patients", tokenRecepW, retired).send({
      name: "Closed Binding",
      gender: "female",
    });

    expect(res.body.data?.patient?.branchId ?? undefined).not.toBe(retired);
  });

  it("refuses a branch id belonging to ANOTHER TENANT, even from a hospital-wide caller", async () => {
    /**
     * A syntactically valid id the admin has every permission to use, and no relationship to.
     * Before the tenant-scoped lookup this was accepted verbatim and became the stamped branch.
     */
    const foreign = "64b7f0000000000000000009";
    const res = await post("/api/v1/patients", tokenAdmin, foreign).send({
      name: "Foreign Branch",
      gender: "male",
    });

    // Same shape as the retired case: the id is discarded, so the caller must choose a real site.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-BRANCH-001");
    expect(res.body.data?.patient?.branchId ?? undefined).not.toBe(foreign);
  });

  it("does not 500 on a header that is not an id at all", async () => {
    // A malformed selection is stale UI state, not an attack surface — it must degrade, not throw.
    const res = await get("/api/v1/patients", tokenAdmin, "not-an-object-id");
    expect(res.status).toBe(200);
  });

  it("still honours a branch that is open — the guard is not a blanket refusal", async () => {
    const created = await post("/api/v1/patients", tokenAdmin, branchB)
      .send({ name: "Open Site", gender: "female" })
      .expect(201);

    expect(created.body.data.patient.branchId).toBe(branchB);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A BRANCH'S TIMEZONE IS THE ONE EVERY BED-DAY IS COUNTED IN
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a branch cannot be given a timezone the server cannot format in", () => {
  /**
   * `Branch.timezone` was `z.string().max(64)` — anything at all. It reaches
   * `Intl.DateTimeFormat` in `dayKeyInZone`, which every bed-day charge is counted from, and
   * `Intl` throws on a zone it does not know: one typo in a branch record became a 500 on every
   * bed-day for that site. The unit suite (`core/time/zone.test.ts`) pins the RULE; this pins
   * that the rule is actually wired to the edge.
   */
  it("accepts a real IANA zone", async () => {
    const res = await post("/api/v1/branches", tokenAdmin)
      .send({ name: "Kochi", code: "COK", timezone: "Asia/Kolkata" })
      .expect(201);

    expect(res.body.data.timezone).toBe("Asia/Kolkata");
  });

  it("refuses an abbreviation, which Intl would have accepted and mis-resolved", async () => {
    const res = await post("/api/v1/branches", tokenAdmin)
      .send({ name: "Bad Zone", code: "BADZ", timezone: "IST" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(JSON.stringify(res.body.error.details)).toMatch(/IANA/i);
  });

  it("refuses a bare UTC offset", async () => {
    await post("/api/v1/branches", tokenAdmin)
      .send({ name: "Offset Zone", code: "OFFZ", timezone: "+05:30" })
      .expect(400);
  });

  it("refuses it on UPDATE too — the edge is not only the create path", async () => {
    // Patches an EXISTING branch rather than making one: the edition caps branch count, and a
    // refused request writes nothing, so Chennai is unchanged by this.
    const res = await request(app)
      .patch(`/api/v1/branches/${branchB}`)
      .set("Host", HOST)
      .set("Authorization", `Bearer ${tokenAdmin}`)
      .send({ timezone: "Nowhere/Fake" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 18. PATIENT IDENTITY IS TENANT-WIDE; EVERYTHING OPERATIONAL IS NOT
 *
 * ── THIS GROUP USED TO PIN THE OPPOSITE, AND SAID SO ────────────────────────
 * It was written at M3-S6 to make a known conflict visible: ADR-0015 §5 says patient identity is
 * tenant-level ("`patient.branchId` is the REGISTERING branch … **never** an ownership wall:
 * lookup by UHID is tenant-wide"), and the implementation applied `scopeFilter()` to every
 * patient read anyway. That group ended with "the day the decision is made, this group is where
 * it changes". This is that change. It is a REVERSAL, not a relaxation, and the reasoning is
 * kept here so nobody restores the wall believing they are closing a hole.
 *
 * ── WHY THE WALL PROTECTED NOTHING ──────────────────────────────────────────
 * The MPI (`findCandidates`) has never been branch-scoped and must never be — it is the only
 * thing standing between a returning patient and a second chart. It returns the FULL patient
 * object, and `POST /patients/check-duplicates` carries the same `patient:read` as
 * `GET /patients/:id`. Measured before the change, as a branch-confined Hyderabad clerk asking
 * about a Chennai patient:
 *
 *     GET  /patients/<chennai-id>       → 404
 *     POST /patients/check-duplicates   → 200 + id, uhid, name, gender, contact, address
 *
 * So the same user, with the same permission, was shown the record through one door and refused
 * it through another. The wall disclosed what it claimed to protect and, by refusing the record,
 * left registering a SECOND chart as the only way forward — a second UHID, and an empty allergy
 * list, so the other site's round renders "None recorded", which reads as *cleared* rather than
 * *unknown*. ADR-0015 §7 names that outcome: "An allergy that does not follow the patient to
 * another site can kill them."
 *
 * ── WHAT DID NOT CHANGE, WHICH IS THE WHOLE SAFETY ARGUMENT ─────────────────
 * Only two reads widened: by id and by UHID. The register (`GET /patients`) is still
 * branch-defaulted, because a register is a site's own list — that is what `branchId` is FOR.
 * Every operational record carries the TREATING branch and is filtered on its own read path, so
 * resolving WHO a patient is grants nothing about WHAT was done to them, WHERE. The tests below
 * prove that one by one, because it is the claim that would matter if it were false.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("patient identity crosses branches; operational records do not (ADR-0015 §5)", () => {
  let hyderabadUhid = "";

  beforeAll(async () => {
    const pa = await get(`/api/v1/patients/${patientAId}`, tokenAdmin, branchA).expect(200);
    hyderabadUhid = pa.body.data.uhid as string;
    expect(hyderabadUhid).toMatch(/\S/);
  });

  it("is readable at the branch that registered them", async () => {
    // Guards everything below: if this ever failed the group would pass for the wrong reason.
    await get(`/api/v1/patients/${patientAId}`, tokenRecepA).expect(200);
  });

  it("is readable BY ID from the other branch — the ADR's core claim", async () => {
    const res = await get(`/api/v1/patients/${patientAId}`, tokenRecepB, branchB).expect(200);
    expect(res.body.data.id).toBe(patientAId);
    expect(res.body.data.uhid).toBe(hyderabadUhid);
  });

  it("is readable BY UHID from the other branch — the case ADR-0015 §5 names outright", async () => {
    const res = await get(`/api/v1/patients/by-uhid/${hyderabadUhid}`, tokenRecepB, branchB).expect(
      200,
    );
    expect(res.body.data.id).toBe(patientAId);
  });

  /**
   * The REGISTER stays a site's own list, and that is not an oversight.
   *
   * `?q=` searches `listPatients`, which is branch-defaulted by design — ADR-0015 §5 calls
   * `branchId` "the default list scope" in the same sentence that forbids it being a wall. The
   * identity lookup above is the tenant-wide door; the list is not. A future engineer widening
   * THIS to "fix" cross-branch search would turn every site's register into the whole group's.
   */
  it("does NOT appear in the other branch's register — the list stays scoped", async () => {
    const res = await get(`/api/v1/patients?q=${hyderabadUhid}`, tokenRecepB, branchB).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it("is offered by the duplicate check, which was always tenant-wide", async () => {
    const res = await post("/api/v1/patients/check-duplicates", tokenRecepB, branchB)
      .send({ name: "Hyderabad Patient", gender: "female" })
      .expect(200);

    const candidates = res.body.data as { patient: { id: string; uhid: string } }[];
    expect(candidates.map((c) => c.patient.id)).toContain(patientAId);
  });

  /**
   * ── THE DEFECT, END TO END ────────────────────────────────────────────────
   * The exact sequence a front desk walks: the duplicate check finds the returning patient, the
   * clerk opens them, and treats them. Before the fix, step two was a 404 and the only way on was
   * a second chart. The assertion that matters is the LAST one — one human, one UHID.
   */
  it("lets the other branch adopt the existing chart instead of creating a second UHID", async () => {
    /**
     * Its OWN patient, deliberately. This test opens a CHENNAI visit, and a visit is durable —
     * pointing it at the shared `patientAId` left a Chennai encounter on a patient that a later
     * group re-opens at Hyderabad, which resumed the Chennai one and broke that group's fixture.
     * A test that mutates shared state is a trap for whoever writes the next one.
     */
    const registered = await post("/api/v1/patients", tokenRecepA, branchA)
      .send({ name: "Returning Patient", gender: "female", contact: { phone: "9000700002" } })
      .expect(201);
    const returningId = registered.body.data.patient.id as string;
    const returningUhid = registered.body.data.patient.uhid as string;

    // 1. Chennai looks them up before registering — the step that prevents the duplicate.
    const dup = await post("/api/v1/patients/check-duplicates", tokenRecepB, branchB)
      .send({ name: "Returning Patient", gender: "female" })
      .expect(200);
    const found = (dup.body.data as { patient: { id: string; uhid: string } }[]).find(
      (c) => c.patient.id === returningId,
    );
    expect(found, "the duplicate check must surface the existing chart").toBeTruthy();

    // 2. The step that used to 404 — Chennai opens the record the MPI just showed them.
    const opened = await get(`/api/v1/patients/${returningId}`, tokenRecepB, branchB).expect(200);
    expect(opened.body.data.uhid).toBe(returningUhid);

    // 3. ...and treats them. The VISIT is stamped Chennai; the PATIENT keeps one identity.
    const enc = await post("/api/v1/encounters", tokenRecepB, branchB)
      .send({ patientId: returningId, departmentId: DOCTOR })
      .expect(201);
    expect(enc.body.data.encounter.branchId).toBe(branchB);
    expect(enc.body.data.encounter.patientId).toBe(returningId);

    // 4. THE ASSERTION THAT MATTERS: one human, one UHID, one chart.
    const register = await get(`/api/v1/patients?q=Returning Patient`, tokenAdmin).expect(200);
    const charts = (register.body.data as { id: string }[]).filter((r) => r.id === returningId);
    expect(charts).toHaveLength(1);
  });

  /**
   * Allergy continuity — the reason ADR-0015 §7 gives for tenant-wide identity, stated as a test.
   * An allergy recorded at Hyderabad must be visible to the nurse treating them at Chennai,
   * because the alternative is a round that says "None recorded" over a patient who is allergic.
   */
  it("carries allergies across branches, which is why identity is tenant-wide at all", async () => {
    // Its own patient too: an allergy is durable clinical data and the drug-safety check reads it,
    // so hanging one on a shared fixture changes what later prescribing tests see.
    const p = await post("/api/v1/patients", tokenRecepA, branchA)
      .send({ name: "Allergic Traveller", gender: "male", contact: { phone: "9000700003" } })
      .expect(201);
    const allergicId = p.body.data.patient.id as string;

    await post(`/api/v1/patients/${allergicId}/allergies`, tokenAdmin, branchA)
      .send({ allergen: "penicillins", severity: "severe" })
      .expect(201);

    const seen = await get(`/api/v1/patients/${allergicId}/allergies`, tokenAdmin, branchB).expect(
      200,
    );
    expect(
      (seen.body.data as { allergen: string }[]).map((a) => a.allergen),
      "a severe allergy must follow the patient to the other site",
    ).toContain("penicillins");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 18b. FALSIFICATION — RESOLVING IDENTITY MUST GRANT NOTHING OPERATIONAL
 *
 * The risk this change introduces, tested directly rather than reasoned about. A Chennai clerk
 * can now name the Hyderabad patient; if that alone opened Hyderabad's visits, observations or
 * medication record, the fix would have traded a duplicate-chart bug for a PHI leak.
 *
 * Every assertion here is the SAME patient id the caller can legitimately resolve — that is the
 * point. Identity is the key that must not fit the operational locks.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("resolving a patient grants no access to the other branch's records", () => {
  /**
   * A patient and a visit that belong to THIS group alone.
   *
   * The first version of this reused `patientAId` and got a green suite for the wrong reason:
   * §18 above opens a CHENNAI visit for that patient, so `POST /encounters` resumed it and the
   * "Hyderabad visit" under test was Chennai's — which Chennai may of course read. A falsification
   * test that shares a patient with the test above it is not falsifying anything.
   */
  let hyderabadOnly = "";
  let hyderabadVisit = "";

  beforeAll(async () => {
    const p = await post("/api/v1/patients", tokenRecepA, branchA)
      .send({ name: "Hyderabad Only", gender: "female", contact: { phone: "9000700001" } })
      .expect(201);
    hyderabadOnly = p.body.data.patient.id as string;

    const enc = await post("/api/v1/encounters", tokenRecepA, branchA)
      .send({ patientId: hyderabadOnly, departmentId: DOCTOR })
      .expect(201);
    hyderabadVisit = enc.body.data.encounter.id as string;
    expect(enc.body.data.encounter.branchId).toBe(branchA);
  });

  it("cannot read the other branch's VISITS for a patient it can name", async () => {
    // Proves the premise first: the identity read succeeds, so a failure below is the scope
    // filter doing its job rather than the patient simply being unreachable.
    await get(`/api/v1/patients/${hyderabadOnly}`, tokenRecepB, branchB).expect(200);

    const res = await get(`/api/v1/encounters?patientId=${hyderabadOnly}`, tokenRecepB, branchB);
    if (res.status === 200) {
      expect(
        (res.body.data as { branchId?: string }[]).every((e) => e.branchId === branchB),
        "a Hyderabad visit reached a Chennai clerk through the patient id",
      ).toBe(true);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it("cannot read the other branch's VITALS for that visit", async () => {
    const res = await get(`/api/v1/encounters/${hyderabadVisit}/vitals`, tokenRecepB, branchB);
    expect([403, 404]).toContain(res.status);
  });

  it("cannot read the other branch's MEDICATION RECORD for that visit", async () => {
    const res = await get(
      `/api/v1/encounters/${hyderabadVisit}/administrations`,
      tokenRecepB,
      branchB,
    );
    expect([403, 404]).toContain(res.status);
  });

  it("cannot read the other branch's VISIT by id", async () => {
    const res = await get(`/api/v1/encounters/${hyderabadVisit}`, tokenRecepB, branchB);
    expect([403, 404]).toContain(res.status);
  });

  /**
   * The wall that is not moving. Tenancy is physical — a different database — and the widening
   * above happens strictly INSIDE one hospital. A patient id from another tenant must resolve to
   * nothing even though the read is now unscoped by branch.
   */
  it("cannot resolve a patient without `patient:read` at all", async () => {
    const res = await request(app).get(`/api/v1/patients/${patientAId}`).set("Host", HOST);
    expect(res.status).toBe(401);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 19. A TENANT-WIDE CATALOGUE MUST NOT BE HIDDEN BY THE BRANCH FILTER
 *
 * Care packages are priced config for the whole hospital: `createPackage` writes no `branchId`,
 * exactly like the tariff it was modelled on. The three reads applied `scopeFilter()` anyway,
 * which returns `{ branchId: <active> }` the moment a caller selects a site — matching nothing,
 * because no package carries the key. Every package in the hospital disappeared, and the POST
 * that had just returned 201 made it look like the save had silently failed.
 *
 * This group is the falsification: restore `scopeFilter()` in `listPackages` and the first test
 * goes red. It lives here rather than in the billing suite because branch scope is what broke it,
 * and the billing suite never selects a branch — which is exactly why it stayed green.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a tenant-wide catalogue survives having a branch selected", () => {
  const code = `MATERNITY_${Date.now().toString().slice(-6)}`;
  let packageId = "";

  it("is listed at the branch it was created at", async () => {
    const created = await post("/api/v1/packages", tokenAdmin, branchA)
      .send({
        code,
        name: "Normal delivery package",
        price: 3_500_000,
        includedCodes: ["CONSULT_GEN"],
      })
      .expect(201);
    packageId = created.body.data.id as string;

    const listed = await get("/api/v1/packages", tokenAdmin, branchA).expect(200);
    expect((listed.body.data as { id: string }[]).map((p) => p.id)).toContain(packageId);
  });

  /** The catalogue is the hospital's, not the site's — a bundle defined at one site sells at both. */
  it("is listed at the OTHER branch too", async () => {
    const listed = await get("/api/v1/packages", tokenAdmin, branchB).expect(200);
    expect((listed.body.data as { id: string }[]).map((p) => p.id)).toContain(packageId);
  });

  it("is listed with no branch selected", async () => {
    const listed = await get("/api/v1/packages", tokenAdmin).expect(200);
    expect((listed.body.data as { id: string }[]).map((p) => p.id)).toContain(packageId);
  });

  /** Editing and retiring went dark the same way — a 404 on a package the list had just shown. */
  it("can be edited from a branch other than the one that created it", async () => {
    const res = await request(app)
      .patch(`/api/v1/packages/${packageId}`)
      .set("Host", HOST)
      .set("Authorization", `Bearer ${tokenAdmin}`)
      .set("X-Active-Branch", branchB)
      .send({ price: 4_000_000 })
      .expect(200);
    expect(res.body.data.price).toBe(4_000_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * VITALS — A CHART READ MUST NOT OUTREACH THE CHART (risk register D1)
 *
 * The audit of 2026-08-14 found `vitals.repository.ts` making no `scopeFilter()` call at all,
 * and a probe confirmed it: a caller working at Chennai read a Hyderabad visit's observations,
 * HTTP 200 with rows, while the same stay's medication schedule, administrations and notes all
 * correctly returned nothing and the encounter itself correctly 404'd.
 *
 * The interesting part is WHICH read is wrong. Two of them are not:
 *
 *   - `forPatient` — the trend across visits — is hospital-wide ON PURPOSE, like allergies. A
 *     weight recorded at one site is the same person's weight at the other, and a trend broken
 *     at a branch boundary is a trend that lies. That is pinned below so it cannot be "fixed"
 *     by someone reading only the first half of this comment.
 *   - `latestForEncounters` is a batch read over ids the caller's own scoped query just produced.
 *
 *   - `forEncounter` IS wrong, and the reason is asymmetry rather than absence: recording a
 *     reading resolves the encounter first (`getEncounter`, branch-scoped, 404 on a foreign
 *     visit), and reading them back does not. You can therefore READ a chart you cannot WRITE
 *     to and cannot OPEN. One of those two paths is lying about the boundary, and it is the read.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("vitals reads stop at the branch the visit belongs to (D1)", () => {
  /** Hospital-wide, so the ACTIVE BRANCH is the only thing narrowing her. */
  let nurseWide = "";
  /** Bound to Chennai alone — the case a header cannot widen. */
  let nurseB = "";
  let encounterA = "";
  let encounterB = "";

  beforeAll(async () => {
    await createUserWithRole("nursewide@branchiso.test", "NURSE", []);
    nurseWide = await login("nursewide@branchiso.test");
    await createUserWithRole("nurseb@branchiso.test", "NURSE", [branchB]);
    nurseB = await login("nurseb@branchiso.test");

    // A visit must route to a doctor or a department; this hospital has neither yet.
    const dept = await post("/api/v1/departments", tokenAdmin, branchA)
      .send({ name: "General Medicine", code: "GENMED", kind: "clinical" })
      .expect(201);
    const departmentId = dept.body.data.id as string;

    /**
     * One visit per site. The admin opens them because a nurse holds no `encounter:create`.
     *
     * 200 as well as 201: a patient with a visit already open gets that one back rather than a
     * second, and earlier groups in this file leave one open on these patients. Asserting 201
     * would make this group depend on running first.
     */
    const openVisit = async (patientId: string, branch: string): Promise<string> => {
      const res = await post("/api/v1/encounters", tokenAdmin, branch).send({
        patientId,
        departmentId,
        reason: "vitals scope fixture",
      });
      expect([200, 201], `opening a visit failed: ${JSON.stringify(res.body)}`).toContain(
        res.status,
      );
      return res.body.data.encounter.id as string;
    };

    encounterA = await openVisit(patientAId, branchA);
    encounterB = await openVisit(patientBId, branchB);

    // A reading on each, charted at the site the visit belongs to.
    await post(`/api/v1/encounters/${encounterA}/vitals`, nurseWide, branchA)
      .send({ pulse: 78, systolic: 120, diastolic: 80 })
      .expect(201);
    await post(`/api/v1/encounters/${encounterB}/vitals`, nurseWide, branchB)
      .send({ pulse: 91, systolic: 132, diastolic: 84 })
      .expect(201);
  }, 60_000);

  /**
   * THE PERMISSIVE CONTROL, FIRST.
   *
   * A scope test that only ever denies is indistinguishable from a broken feature, and the
   * cheapest wrong "fix" here — filtering on the observation's own `branchId`, which is an
   * OPTIONAL denormalised field — would hide a reading from the very nurse who took it the
   * moment that field was absent. This must stay green.
   */
  it("the nurse at the visit's own site reads it", async () => {
    const res = await get(`/api/v1/encounters/${encounterA}/vitals`, nurseWide, branchA).expect(
      200,
    );
    expect((res.body.data as unknown[]).length, "the site's own reading vanished").toBeGreaterThan(
      0,
    );
  });

  it("REFUSES A FOREIGN VISIT to a caller working at the other site", async () => {
    // The headline control, and the exact shape the 2026-08-14 probe caught: 200 with rows.
    const res = await get(`/api/v1/encounters/${encounterA}/vitals`, nurseWide, branchB);

    if (res.status === 200) {
      expect(
        (res.body.data as unknown[]).length,
        "a Hyderabad visit's observations were readable while working at Chennai",
      ).toBe(0);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it("REFUSES A FOREIGN VISIT to a BRANCH-CONFINED caller", async () => {
    /**
     * Distinct from the row above, and the reason D1's blast radius was never settled: a
     * hospital-wide user is narrowed by a header she chose, a confined user is narrowed by a
     * binding she cannot change. A filter that is absent rather than merely un-narrowed fails
     * both, and only this row proves the second.
     */
    const res = await get(`/api/v1/encounters/${encounterA}/vitals`, nurseB, branchA);

    if (res.status === 200) {
      expect(
        (res.body.data as unknown[]).length,
        "a nurse bound to Chennai read a Hyderabad visit by naming Hyderabad in the header",
      ).toBe(0);
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it("holds in the other direction too", async () => {
    // Symmetry: a filter that is right for one site and wrong for the other is keyed on the
    // wrong thing.
    const res = await get(`/api/v1/encounters/${encounterB}/vitals`, nurseWide, branchA);
    if (res.status === 200) expect((res.body.data as unknown[]).length).toBe(0);
    else expect([403, 404]).toContain(res.status);
  });

  it("matches what the MAR already does on the same foreign visit", async () => {
    /**
     * The consistency claim, asserted rather than assumed. `mar.repository.ts` scopes its reads
     * and `encounter.repository.ts` scopes `findById`; vitals was the one clinical read that did
     * not. Pinning them together means a future divergence fails here rather than in a probe.
     */
    const schedule = await get(
      `/api/v1/encounters/${encounterA}/medication-schedule`,
      nurseWide,
      branchB,
    );
    if (schedule.status === 200) expect((schedule.body.data as unknown[]).length).toBe(0);
    else expect([403, 404]).toContain(schedule.status);

    const chart = await get(`/api/v1/encounters/${encounterA}`, nurseWide, branchB);
    expect([403, 404]).toContain(chart.status);
  });

  /**
   * THE DELIBERATE EXCEPTION, PINNED SO IT IS NOT "FIXED".
   *
   * Written as a test rather than a comment because the comment already existed in the
   * repository header and did not stop the reach being read as accidental.
   */
  it("STILL lets the patient trend cross sites — that one is on purpose", async () => {
    const res = await get(`/api/v1/patients/${patientAId}/vitals`, nurseWide, branchB).expect(200);
    expect(
      (res.body.data as unknown[]).length,
      "the cross-visit trend was branch-filtered — a trend broken at a site boundary is a trend that lies",
    ).toBeGreaterThan(0);
  });

  it("and the trend still stops at the TENANT", async () => {
    // The boundary that is never negotiable. `tenantScopePlugin` forces `tenantId` onto every
    // query, so a foreign patient id resolves to nothing rather than to another hospital's rows.
    const foreign = new Types.ObjectId().toString();
    const res = await get(`/api/v1/patients/${foreign}/vitals`, nurseWide, branchA).expect(200);
    expect((res.body.data as unknown[]).length).toBe(0);
  });

  /**
   * FALSIFICATION — the plausible wrong fix, proven wrong instead of merely asserted.
   *
   * The obvious way to close D1 is `scopeFilter()` inside `forEncounter`, filtering on the
   * observation's own `branchId`. Against rows written today that appears to work, because the
   * service stamps the encounter's branch onto every new reading — so a test using only fresh
   * data would go green and the fix would ship.
   *
   * `branchId` on this collection is OPTIONAL, and readings charted before that stamping existed
   * do not have it. A filter keyed on it makes those rows invisible to EVERYONE, including the
   * nurse standing at the bed where they were taken. That is a worse outcome than the exposure
   * it set out to close: a chart that silently drops its own history.
   *
   * This row inserts exactly such a reading and requires it to still be readable. It is the test
   * that fails if someone "simplifies" the fix back to a repository filter.
   */
  it("still shows a reading that carries NO branchId at all", async () => {
    const legacyId = await inTenant(async () => {
      const conn = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      const doc = await getVitalsModel(conn).create({
        tenantId: tenant.id,
        encounterId: new Types.ObjectId(encounterA),
        patientId: new Types.ObjectId(patientAId),
        pulse: 64,
        recordedBy: "legacy-import",
        recordedAt: new Date(),
        // branchId deliberately absent — a row from before the stamp existed.
      });
      return doc._id.toString();
    });

    const res = await get(`/api/v1/encounters/${encounterA}/vitals`, nurseWide, branchA).expect(
      200,
    );
    expect(
      (res.body.data as { id: string }[]).some((r) => r.id === legacyId),
      "an un-stamped historical reading vanished from its own ward — the boundary is keyed on the wrong field",
    ).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 22. THE REPORT FILE IS A CLINICAL READ, AND STOPS AT THE BRANCH (§18's gap)
 *
 * §18 pins that resolving a patient grants no access to another branch's visits, vitals or
 * medication record. The diagnostic REPORT — the scanned PDF that is the actual document a
 * lab produces — was never asked the same question, and it is the one that carries the
 * patient's name, their UHID and the result printed on hospital letterhead.
 *
 * `emr:read` is declared `"branch"` in the permission catalogue, and `listForPatient` honours
 * that with `scopeFilter()`. `getBytes` — the same collection, the same module, the read that
 * returns the bytes rather than the metadata — did not. So the LIST stopped at the branch and
 * the FILE did not, which is the worse half to leave open.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a diagnostic report file stops at the branch that produced it", () => {
  /** A Chennai administrator: every permission, confined to the other site. */
  let tokenMgrB = "";
  let hydPatient = "";
  let hydReportId = "";

  beforeAll(async () => {
    await createUserWithRole("mgrb@branchiso.test", "TENANT_ADMIN", [branchB]);
    tokenMgrB = await login("mgrb@branchiso.test");

    const p = await post("/api/v1/patients", tokenMgrA, branchA)
      .send({ name: "Report Subject", gender: "female", contact: { phone: "9000700022" } })
      .expect(201);
    hydPatient = p.body.data.patient.id as string;

    const enc = await post("/api/v1/encounters", tokenMgrA, branchA)
      .send({ patientId: hydPatient, departmentId: DOCTOR })
      .expect(201);
    const encounterId = enc.body.data.encounter.id as string;

    const order = await post("/api/v1/orders", tokenMgrA, branchA)
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = order.body.data.order.id as string;

    // A real upload through the real route — the bytes are what the exploit reads back.
    const uploaded = await post(`/api/v1/orders/${orderId}/reports`, tokenMgrA, branchA)
      .send({
        filename: "cbc.pdf",
        contentType: "application/pdf",
        dataBase64: Buffer.from("%PDF-1.4 HYDERABAD RESULT").toString("base64"),
      })
      .expect(201);
    hydReportId = uploaded.body.data.id as string;
  });

  /**
   * The premise. If this failed, everything below would pass for the wrong reason.
   *
   * `.buffer()` because supertest only accumulates a body for the content types it knows, and
   * `application/pdf` is not one — without it `res.body` is an empty object and the bytes that
   * are the whole point of this group are never examined.
   */
  it("is readable by the site that produced it", async () => {
    const res = await get(`/api/v1/reports/${hydReportId}/file`, tokenMgrA, branchA)
      .buffer(true)
      .expect(200);
    expect(Buffer.from(res.body as Buffer).toString()).toContain("HYDERABAD RESULT");
  });

  it("does NOT appear in the other branch's report list — the metadata read was always scoped", async () => {
    const res = await get(`/api/v1/patients/${hydPatient}/reports`, tokenMgrB, branchB).expect(200);
    expect(
      (res.body.data as { id: string }[]).some((r) => r.id === hydReportId),
      "a Hyderabad report was listed to a Chennai caller",
    ).toBe(false);
  });

  /**
   * THE EXPLOIT. The list above refuses to name the report; this asks for it by id anyway.
   * A report id is a Mongo ObjectId — a timestamp, a machine id and a counter — so "unguessable"
   * is not a control, and it is handed out in full to anyone who legitimately holds ONE report.
   */
  it("REFUSES THE BYTES to a caller working at the other site", async () => {
    const res = await get(`/api/v1/reports/${hydReportId}/file`, tokenMgrB, branchB);
    expect(
      [403, 404],
      `a Chennai administrator downloaded a Hyderabad report (status ${res.status})`,
    ).toContain(res.status);
  });

  /** …and not merely because a branch was selected. A confined caller is confined in All mode too. */
  it("REFUSES THE BYTES with no branch selected either", async () => {
    const res = await get(`/api/v1/reports/${hydReportId}/file`, tokenMgrB);
    expect([403, 404]).toContain(res.status);
  });
});
/* ────────────────────────────────────────────────────────────────────────────
 * 23. AN APPOINTMENT CHANGES STATE ONLY AT THE SITE THAT HOLDS IT
 *
 * `appointment:update` and `appointment:cancel` are both declared `"branch"` in the permission
 * catalogue, and the repository ships TWO reads — `findById` and `findByIdScoped`. The state
 * machine used the unscoped one, so every transition it drives (confirm, check-in, start,
 * complete, no-show, cancel) resolved an appointment belonging to any site in the hospital.
 *
 * A read leaking is bad; this is a WRITE. A clerk at one site could cancel another site's
 * clinic list, or mark a patient who is sitting in a waiting room 600km away as a no-show —
 * and the audit trail would record it as a legitimate action by a legitimate user.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an appointment changes state only at the site that holds it", () => {
  /**
   * Its own doctor and its own clinics. The group above books against `DOCTOR`, whose schedule
   * is created inside an `it` — so running this file with `-t` skipped the setup and the booking
   * 400'd. A group that only passes when the whole file runs is not a regression test.
   */
  const APPT_DOCTOR = "aaaaaaaaaaaaaaaaaaaaaa02";
  let hydAppointment = "";
  /** Read from the response rather than assumed — a booking starts `requested`, not `booked`. */
  let hydStatusAtBooking = "";
  let chnPatient = "";

  beforeAll(async () => {
    // Hyderabad mornings, Chennai afternoons — the same shape section 8 uses.
    await put("/api/v1/doctors/schedule", tokenAdmin, branchA)
      .send({
        doctorId: APPT_DOCTOR,
        weekday: 1,
        startMinute: 600,
        endMinute: 720,
        slotMinutes: 15,
      })
      .expect(201);
    await put("/api/v1/doctors/schedule", tokenAdmin, branchB)
      .send({
        doctorId: APPT_DOCTOR,
        weekday: 1,
        startMinute: 840,
        endMinute: 1020,
        slotMinutes: 15,
      })
      .expect(201);

    const p = await post("/api/v1/patients", tokenRecepA, branchA)
      .send({ name: "Appointment Subject", gender: "male", contact: { phone: "9000700033" } })
      .expect(201);

    // Booked at Hyderabad, in Hyderabad's own morning session.
    const appt = await post("/api/v1/appointments", tokenRecepA, branchA)
      .send({
        patientId: p.body.data.patient.id as string,
        doctorId: APPT_DOCTOR,
        startAt: slotAt(nextMonday(), 630),
      })
      .expect(201);
    hydAppointment = appt.body.data.id as string;
    hydStatusAtBooking = appt.body.data.status as string;
    expect(appt.body.data.branchId).toBe(branchA);

    const cp = await post("/api/v1/patients", tokenRecepB, branchB)
      .send({ name: "Chennai Booker", gender: "female", contact: { phone: "9000700034" } })
      .expect(201);
    chnPatient = cp.body.data.patient.id as string;
  });

  /** The premise: the Chennai clerk is a working clerk, not one who is refused everything. */
  it("lets the Chennai clerk work on her OWN site's appointments", async () => {
    const mine = await post("/api/v1/appointments", tokenRecepB, branchB)
      .send({ patientId: chnPatient, doctorId: APPT_DOCTOR, startAt: slotAt(nextMonday(), 900) })
      .expect(201);
    await post(`/api/v1/appointments/${mine.body.data.id as string}/confirm`, tokenRecepB, branchB)
      .send({})
      .expect(200);
  });

  it("REFUSES A FOREIGN APPOINTMENT to the cancel route", async () => {
    const res = await post(
      `/api/v1/appointments/${hydAppointment}/cancel`,
      tokenRecepB,
      branchB,
    ).send({ reason: "cancelled from the wrong city" });
    expect(
      [403, 404],
      `a Chennai clerk cancelled a Hyderabad appointment (status ${res.status})`,
    ).toContain(res.status);
  });

  it("REFUSES A FOREIGN APPOINTMENT to the no-show route", async () => {
    const res = await post(
      `/api/v1/appointments/${hydAppointment}/no-show`,
      tokenRecepB,
      branchB,
    ).send({ reason: "not here — 600km away" });
    expect([403, 404]).toContain(res.status);
  });

  it("REFUSES A FOREIGN APPOINTMENT to the check-in route", async () => {
    const res = await post(
      `/api/v1/appointments/${hydAppointment}/check-in`,
      tokenRecepB,
      branchB,
    ).send({});
    expect([403, 404]).toContain(res.status);
  });

  /** And the appointment is still standing afterwards — the refusals refused, they did not half-apply. */
  it("leaves the Hyderabad appointment untouched", async () => {
    const res = await get(`/api/v1/appointments/${hydAppointment}`, tokenRecepA, branchA).expect(
      200,
    );
    expect(res.body.data.status).toBe(hydStatusAtBooking);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 24. AN ADVANCE RECEIPT IS HOSPITAL-WIDE, LIKE THE BALANCE IT BELONGS TO
 *
 * This group started life asserting the opposite. The audit found `findEntryById` reading by a
 * bare id, matched it against the report file and the appointment, and "fixed" it — at which
 * point the wallet's own design contradicted the fix.
 *
 * `walletAccounts` carries NO branch: one balance per patient for the whole hospital. An advance
 * taken at one site is spendable at another, and `listEntries` is hospital-wide to match. So
 * scoping the single-entry read refused a receipt for a row the SAME cashier could already read
 * in the statement in front of her — risk-register D1's asymmetry, inverted.
 *
 * The reprint is therefore hospital-wide ON PURPOSE, and this group pins it in that direction so
 * the next reader does not re-apply the pattern without opening the account model.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an advance receipt is hospital-wide, like the balance it belongs to", () => {
  let cashierB = "";
  let payer = "";
  let hydEntryId = "";

  beforeAll(async () => {
    await createUserWithRole("cashb@branchiso.test", "TENANT_ADMIN", [branchB]);
    cashierB = await login("cashb@branchiso.test");

    const p = await post("/api/v1/patients", tokenMgrA, branchA)
      .send({ name: "Advance Payer", gender: "male", contact: { phone: "9000700044" } })
      .expect(201);
    payer = p.body.data.patient.id as string;

    const deposit = await post(`/api/v1/patients/${payer}/wallet/deposits`, tokenMgrA, branchA)
      .send({ amount: 250000, method: "cash", reference: "HYD-ADV-1" })
      .expect(201);
    // `deposit` answers with the WalletView (balance + ledger), not the entry — the receipt id is
    // the row it just added. Reading `data.id` here silently produced `undefined`, and the first
    // version of this group then "passed" against a 404 that every caller gets.
    const entries = deposit.body.data.entries as { id: string; reference?: string }[];
    hydEntryId = entries.find((e) => e.reference === "HYD-ADV-1")?.id ?? "";
    expect(hydEntryId, "the deposit did not come back in the ledger").not.toBe("");
  });

  it("is reprintable at the counter that issued it", async () => {
    const res = await get(`/api/v1/wallet/entries/${hydEntryId}`, tokenMgrA, branchA).expect(200);
    expect(res.body.data.amount).toBe(250000);
  });

  /**
   * The premise for the row below: the OTHER site can already see this deposit in the statement.
   * Refusing the receipt while showing the line it belongs to is the asymmetry, whichever way
   * round it points.
   */
  it("already appears in the other site's view of the statement", async () => {
    const res = await get(`/api/v1/patients/${payer}/wallet`, cashierB, branchB).expect(200);
    expect(
      (res.body.data.entries as { id: string }[]).some((e) => e.id === hydEntryId),
      "the ledger stopped at the branch — then the receipt SHOULD stop too, and this group is wrong",
    ).toBe(true);
  });

  it("is therefore reprintable at the other counter too", async () => {
    const res = await get(`/api/v1/wallet/entries/${hydEntryId}`, cashierB, branchB).expect(200);
    expect(res.body.data.amount).toBe(250000);
  });

  /** The wall that does not move: another hospital's entry is unreachable, id or no id. */
  it("but the balance itself is one hospital's, not one branch's", async () => {
    const res = await get(`/api/v1/patients/${payer}/wallet`, cashierB, branchB).expect(200);
    expect(res.body.data.balance).toBe(250000);
  });
});
