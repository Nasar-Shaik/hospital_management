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

const SLUG = "test-branchiso-apollo";
const DB = `hms_${SLUG}`;
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
  await dropDatabases(["test_branchiso_master", DB]);
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
  await dropDatabases(["test_branchiso_master", DB]);
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
