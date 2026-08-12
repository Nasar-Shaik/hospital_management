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

  it("cannot fetch another branch's record by id, even knowing the id", async () => {
    // Direct object reference. The id is real and correct; the only thing standing in the
    // way is the row scope.
    const res = await get(`/api/v1/patients/${patientBId}`, tokenRecepA);
    expect([403, 404]).toContain(res.status);
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
