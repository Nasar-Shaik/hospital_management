/**
 * MASTER PATIENT INDEX SUITE — release-gating clinical safety (Doc 02 C1, BUSINESS_WORKFLOWS §1).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT DID NOT ─────────────────────────────────
 * "One patient = one UHID" is the guarantee every other clinical guarantee is built on. A second
 * chart means a second UHID and an EMPTY allergy list — so the other site's medication round
 * renders "None recorded", which a nurse reads as *cleared* rather than as *unknown*. That is the
 * failure the MPI exists to prevent, and it is a patient-safety failure, not a data-quality one.
 *
 * Until this file, **nothing asserted that the MPI refuses anything.** The gap was mapped in
 * `docs/testing/HMS_ROLE_BASED_UAT_TEST_PLAN.md` §20.1 (FD-REG-004/005/006, all C0/P0) and it was
 * real: `rbac.int.test.ts` probed WHO may call `POST /patients` and `POST /patients/check-duplicates`;
 * `branchIsolation.int.test.ts` §18 proved WHAT the check endpoint may disclose across a site
 * boundary. Neither asked whether a probable duplicate is actually stopped. The mechanism works —
 * it refused 17 of 20 synthetic registrations during seed development — and it had no regression
 * test, which is the same thing as having no guarantee.
 *
 * ── THE FOUR CLAIMS THIS SUITE DEFENDS ───────────────────────────────────────
 *   1. A PROBABLE DUPLICATE IS REFUSED, AND THE REFUSAL IS REVIEWABLE. `409 HMS-PAT-002` naming
 *      the candidate — its id, its UHID, its name, its score and WHAT MATCHED. A score with no
 *      reason is not reviewable, and a refusal a clerk cannot act on becomes a refusal they learn
 *      to click past.
 *
 *   2. THE THRESHOLD IS A THRESHOLD. Detection is aggressive and blocking is conservative, and
 *      those are different settings on purpose: `mpi.ts` states the asymmetry outright — a missed
 *      duplicate is ugly and fixable by a merge; a WRONG merge puts one person's allergies on
 *      another person's chart. So a below-threshold near-miss is SHOWN and NOT blocked, and the
 *      tests below pin the boundary at the exact arithmetic (`60`), not at "it warned about
 *      something".
 *
 *   3. THE OVERRIDE IS A PERMISSION, NOT A CHECKBOX. `force` requires `patient:merge`. Without
 *      that gate `force` is the button every clerk learns to click to make the warning go away,
 *      and the whole control becomes decorative. The override is also its own audit entry.
 *
 *   4. IDENTITY IS TENANT-WIDE AND STOPS AT THE TENANT. The MPI deliberately reaches ACROSS
 *      branches — a duplicate must be caught wherever the patient walks in — and must never reach
 *      across hospitals. Those two are one decision with opposite signs, and both are asserted.
 *
 * ── WHAT THIS SUITE DELIBERATELY DOES NOT RE-PROVE ───────────────────────────
 * `branchIsolation.int.test.ts` §18 already owns "the register stays branch-scoped while identity
 * does not", including the end-to-end sequence where the other branch adopts the existing chart.
 * Duplicating it here would be a second source of truth for the same claim. This suite asserts the
 * half §18 does not: that `POST /patients` at the OTHER site is REFUSED. Detecting a duplicate and
 * preventing one are different facts, and only the second one is the guarantee.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("patients");
process.env.MONGO_MASTER_DB = "test_patients_master";
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
const { getPatientModel } = await import("./modules/patients/patient.model.js");
const { DUPLICATE_THRESHOLD } = await import("./modules/patients/mpi.js");
const { registeredMergeGuards } = await import("./core/policy/mergeGuards.js");

const SLUG = "test-mpi-apollo";
const SLUG_OTHER = "test-mpi-sunshine";
const DB = `hms_${SLUG}`;
const DB_OTHER = `hms_${SLUG_OTHER}`;
const HOST = `${SLUG}.medicore.test`;
const HOST_OTHER = `${SLUG_OTHER}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "mpi-int-test" })));

interface Tenant {
  id: string;
  slug: string;
  databaseName: string;
}
let tenant: Tenant;
let other: Tenant;

/** The two sites. Real branches, created through the API — not invented ids. */
let branchA = "";
let branchB = "";

/** Holds `patient:merge` (so `force` is available to it) — see the override group. */
let tokenAdmin = "";
/** Holds `patient:register` and `patient:read`, and NOT `patient:merge`. The gate's subject. */
let tokenReception = "";
let tokenOtherAdmin = "";

async function inTenant<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
  const connection = await getTenantConnection({ id: t.id, databaseName: t.databaseName });
  return runWithContext(
    { traceId: "mpi-setup", tenantId: t.id, tenantSlug: t.slug, connection },
    fn,
  );
}

async function createUserWithRole(
  t: Tenant,
  email: string,
  roleCode: string,
  branchIds: string[] = [],
): Promise<void> {
  await inTenant(t, async () => {
    const user = await createUser({ email, name: email, status: "invited" });
    await setPassword(user.id, PASSWORD, { mustChangePassword: false });
    await assignRoleByCode(user.id, roleCode, branchIds);
    await transitionStatus(user.id, "active");
  });
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

function post(path: string, token: string, host = HOST, activeBranch?: string): request.Test {
  const req = request(app).post(path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return activeBranch ? req.set("X-Active-Branch", activeBranch) : req;
}

function get(path: string, token: string, host = HOST, activeBranch?: string): request.Test {
  const req = request(app).get(path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return activeBranch ? req.set("X-Active-Branch", activeBranch) : req;
}

interface Person {
  name: string;
  gender?: "male" | "female" | "unknown";
  dob?: string;
  phone?: string;
}

function body(p: Person): Record<string, unknown> {
  return {
    name: p.name,
    ...(p.gender ? { gender: p.gender } : {}),
    ...(p.dob ? { dob: p.dob } : {}),
    ...(p.phone ? { contact: { phone: p.phone } } : {}),
  };
}

/** Registers and asserts it succeeded, returning the created row. */
async function register(
  p: Person,
  token = tokenAdmin,
  branch = branchA,
): Promise<{ id: string; uhid: string }> {
  const res = await post("/api/v1/patients", token, HOST, branch).send(body(p)).expect(201);
  return res.body.data.patient as { id: string; uhid: string };
}

/**
 * How many charts exist for this name, counted in the DATABASE rather than through the
 * branch-scoped register. "Duplicate prevented" is a claim about rows, and a list that is
 * filtered by site cannot answer it.
 */
async function chartsNamed(name: string, t: Tenant = tenant): Promise<number> {
  return inTenant(t, async () => {
    const connection = await getTenantConnection({ id: t.id, databaseName: t.databaseName });
    return getPatientModel(connection).countDocuments({ name });
  });
}

interface CandidatePayload {
  id: string;
  uhid: string;
  name: string;
  gender: string;
  phone?: string;
  score: number;
  matchedOn: string[];
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_patients_master", DB, DB_OTHER]);
  await flushTestCache("patients");

  // Enterprise, and `maxBranches` raised, for the same reason the branch-isolation suite does it:
  // a refusal in this file must always be an MPI decision, never "you did not buy this" and never
  // "this hospital may not have a second site".
  const provisioned = await provisionTenant({
    hospitalName: "Apollo MPI",
    slug: SLUG,
    planCode: "PLAN_ENTERPRISE",
    maxBranches: 5,
  });
  tenant = { id: provisioned.tenant.id, slug: SLUG, databaseName: provisioned.tenant.databaseName };

  const second = await provisionTenant({
    hospitalName: "Sunshine MPI",
    slug: SLUG_OTHER,
    planCode: "PLAN_ENTERPRISE",
  });
  other = { id: second.tenant.id, slug: SLUG_OTHER, databaseName: second.tenant.databaseName };

  await inTenant(tenant, seedRbac);
  await inTenant(other, seedRbac);

  await createUserWithRole(tenant, `admin@${SLUG}.test`, "TENANT_ADMIN");
  tokenAdmin = await login(HOST, `admin@${SLUG}.test`);

  const a = await post("/api/v1/branches", tokenAdmin)
    .send({ name: "Hyderabad", code: "HYD" })
    .expect(201);
  const b = await post("/api/v1/branches", tokenAdmin)
    .send({ name: "Chennai", code: "CHN" })
    .expect(201);
  branchA = a.body.data.id as string;
  branchB = b.body.data.id as string;

  await createUserWithRole(tenant, `reception@${SLUG}.test`, "RECEPTIONIST");
  tokenReception = await login(HOST, `reception@${SLUG}.test`);

  await createUserWithRole(other, `admin@${SLUG_OTHER}.test`, "TENANT_ADMIN");
  tokenOtherAdmin = await login(HOST_OTHER, `admin@${SLUG_OTHER}.test`);
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_patients_master", DB, DB_OTHER]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE FIXTURE IS SOUND
 *    Two assertions that cost nothing and stop every group below from passing
 *    for the wrong reason.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the desk can register at all", () => {
  it("issues a UHID for somebody nobody has seen before, with no near-misses", async () => {
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body({ name: "Solitary Person", gender: "female", phone: "9800000900" }))
      .expect(201);

    expect(res.body.data.patient.uhid, "a registration with no UHID is not a registration").toMatch(
      /\S/,
    );
    expect(res.body.data.possibleDuplicates).toEqual([]);
  });

  it("gives two genuinely different people two different UHIDs", async () => {
    const one = await register({ name: "Distinct Alpha", gender: "male", phone: "9800000901" });
    const two = await register({ name: "Distinct Beta", gender: "male", phone: "9800000902" });

    expect(one.uhid).not.toBe(two.uhid);
    expect(one.id).not.toBe(two.id);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. A PROBABLE DUPLICATE IS REFUSED — the claim the module exists to make.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("registering somebody who is already here", () => {
  const PERSON: Person = {
    name: "Ramesh Kumar",
    gender: "male",
    dob: "1990-04-12",
    phone: "9800000001",
  };
  let firstId = "";
  let firstUhid = "";

  beforeAll(async () => {
    const created = await register(PERSON);
    firstId = created.id;
    firstUhid = created.uhid;
  });

  it("refuses the second registration with HMS-PAT-002", async () => {
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body(PERSON))
      .expect(409);

    expect(res.body.error.code).toBe("HMS-PAT-002");
  });

  it("names the candidate it thinks this already is, and what matched", async () => {
    /**
     * The whole point of the refusal. "Possible duplicate" with no candidate is an error message;
     * with a candidate and a reason it is a decision a clerk can make at the desk. `matchedOn` is
     * on the screen for exactly that reason — see `mpi.ts`: "a score with no reason is not
     * reviewable".
     */
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body(PERSON))
      .expect(409);

    const candidates = res.body.error.details.candidates as CandidatePayload[];
    expect(candidates.length).toBeGreaterThan(0);

    const match = candidates.find((c) => c.id === firstId);
    expect(match, "the refusal did not name the patient it refused for").toBeDefined();
    expect(match?.uhid).toBe(firstUhid);
    expect(match?.name).toBe(PERSON.name);
    expect(match?.phone).toBe(PERSON.phone);
    expect(match?.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(match?.matchedOn).toEqual(
      expect.arrayContaining(["phone", "name", "date of birth", "gender"]),
    );
  });

  it("tells the caller what the bar was, so the number is not a mystery", async () => {
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body(PERSON))
      .expect(409);

    expect(res.body.error.details.threshold).toBe(DUPLICATE_THRESHOLD);
    expect(res.body.error.details.hint).toMatch(/force/);
  });

  it("wrote nothing — one human, one chart", async () => {
    // The assertion the other three are worth nothing without. A refusal that still inserted
    // would be the exact defect the MPI exists to prevent, wearing a 409.
    expect(await chartsNamed(PERSON.name)).toBe(1);
  });

  it("still lets the clerk find and open the chart it refused for", async () => {
    /**
     * The refusal is only useful if the way forward is open. If the candidate could not be
     * fetched, the only route past the block would be `force` — and the MPI would have converted
     * a duplicate into a coerced override.
     */
    const res = await get(`/api/v1/patients/${firstId}`, tokenReception, HOST, branchA).expect(200);
    expect(res.body.data.uhid).toBe(firstUhid);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE THRESHOLD IS A THRESHOLD
 *
 *    `mpi.ts` weights: phone 40 · name 35 · dob 20 · gender 5, blocking at 60,
 *    and gender scores ONLY as corroboration. The arithmetic is the design — no
 *    single attribute can block on its own — so these tests pin the numbers and
 *    not merely "something was returned".
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a near-miss is shown, not refused", () => {
  it("a shared phone alone warns and lets the registration through (40 < 60)", async () => {
    /**
     * A family shares one mobile, and a whole village shares the number of the man who owns a
     * phone. Blocking on a phone match would refuse the second child of every family that ever
     * walks in — so phone (40) sits deliberately below the bar and must be corroborated.
     */
    const first = await register({ name: "Phone Household One", phone: "9800000010" });

    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body({ name: "Phone Household Two", phone: "9800000010" }))
      .expect(201);

    const near = res.body.data.possibleDuplicates as { patient: { id: string }; score: number }[];
    expect(near.map((c) => c.patient.id)).toContain(first.id);
    expect(near.find((c) => c.patient.id === first.id)?.score).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("an identical name alone warns and lets the registration through (35 + 5 < 60)", async () => {
    // In a hospital with ten thousand patients an identical name is a coincidence, not a person.
    const first = await register({
      name: "Common Name",
      gender: "male",
      dob: "1970-01-02",
      phone: "9800000011",
    });

    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body({ name: "Common Name", gender: "male", dob: "1988-09-09", phone: "9800000012" }))
      .expect(201);

    const near = res.body.data.possibleDuplicates as {
      patient: { id: string };
      score: number;
      matchedOn: string[];
    }[];
    const hit = near.find((c) => c.patient.id === first.id);
    expect(hit, "an identical name must still be SHOWN to the clerk").toBeDefined();
    expect(hit?.score).toBeLessThan(DUPLICATE_THRESHOLD);
    expect(hit?.matchedOn).toContain("name");
    expect(hit?.matchedOn).not.toContain("date of birth");
  });

  it("name plus date of birth reaches the bar exactly, and stops (35 + 20 + 5 = 60)", async () => {
    /**
     * The boundary, asserted on the boundary. `isProbableDuplicate` is `>=`, so this pair is the
     * cheapest thing that blocks — and if anybody re-tunes a weight, this is the test that says
     * which direction it moved.
     */
    await register({ name: "Boundary Case", gender: "female", dob: "1985-06-30" });

    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body({ name: "Boundary Case", gender: "female", dob: "1985-06-30" }))
      .expect(409);

    expect(res.body.error.code).toBe("HMS-PAT-002");
    const candidates = res.body.error.details.candidates as CandidatePayload[];
    expect(candidates[0]?.score).toBe(DUPLICATE_THRESHOLD);
    expect(await chartsNamed("Boundary Case")).toBe(1);
  });

  it("the same pair with a different gender falls one notch short, and is only a warning", async () => {
    /**
     * Gender CORROBORATES and never accuses: a mismatch is deliberately not a penalty, because
     * registration data is wrong all the time and subtracting points would suppress exactly the
     * duplicate a human should look at. So 55 — shown, not blocked.
     *
     * This is the row most likely to surprise somebody reading a bug report, which is why it is
     * pinned rather than left to be rediscovered.
     */
    const first = await register({
      name: "Gender Corroborates",
      gender: "female",
      dob: "1979-02-11",
    });

    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(body({ name: "Gender Corroborates", gender: "male", dob: "1979-02-11" }))
      .expect(201);

    const near = res.body.data.possibleDuplicates as {
      patient: { id: string };
      score: number;
      matchedOn: string[];
    }[];
    const hit = near.find((c) => c.patient.id === first.id);
    expect(hit?.score).toBe(DUPLICATE_THRESHOLD - 5);
    expect(hit?.matchedOn).not.toContain("gender");
  });

  it("somebody with nothing in common is not offered as a candidate at all", async () => {
    // The negative control. A matcher that returns everybody is a matcher nobody reads.
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send(
        body({ name: "Nothing In Common", gender: "male", dob: "1961-12-25", phone: "9800000099" }),
      )
      .expect(201);

    expect(res.body.data.possibleDuplicates).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE OVERRIDE IS A PERMISSION, NOT A CHECKBOX
 * ──────────────────────────────────────────────────────────────────────────── */

describe("overriding the refusal", () => {
  const TWIN: Person = { name: "Override Twin", gender: "male", dob: "1995-03-03" };

  beforeAll(async () => {
    await register(TWIN);
  });

  it("a clerk without patient:merge is refused the override, and told which permission", async () => {
    /**
     * The gate that decides whether the whole control is real. Without it, `force` is the button
     * every clerk learns to click to make the warning go away — and the MPI becomes a speed bump
     * that trains people to drive over it.
     *
     * Note the code: `HMS-AUTH-005`, not `HMS-PAT-002`. The second registration is not being
     * refused for being a duplicate any more; it is being refused because this person may not
     * make that call. A tester who sees the wrong one of these two is looking at a different bug.
     */
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send({ ...body(TWIN), force: true })
      .expect(403);

    expect(res.body.error.code).toBe("HMS-AUTH-005");
    expect(res.body.error.details.required).toBe("patient:merge");
    expect(res.body.error.details.reason).toMatch(/duplicate/);
  });

  it("and the refused override wrote nothing", async () => {
    expect(await chartsNamed(TWIN.name)).toBe(1);
  });

  it("somebody trusted to make duplicate decisions may proceed", async () => {
    // The other half, and it has to be here: a gate that refuses everybody is not a gate, it is
    // an outage. TENANT_ADMIN holds `patient:merge`.
    const res = await post("/api/v1/patients", tokenAdmin, HOST, branchA)
      .send({ ...body(TWIN), force: true })
      .expect(201);

    expect(res.body.data.patient.uhid).toMatch(/\S/);
    expect(await chartsNamed(TWIN.name)).toBe(2);
  });

  it("an override is recorded as its own event, with the candidates it overrode", async () => {
    /**
     * Someone declaring "these are different people" is a clinical judgement with consequences.
     * It must be findable as an EVENT — not inferred later by somebody noticing a field on a
     * document.
     */
    const entries = await inTenant(tenant, async () => {
      const connection = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      return connection
        .collection("auditLogs")
        .find({ action: "patient.duplicateOverridden" })
        .toArray();
    });

    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.at(-1);
    expect(entry?.resource).toBe("patient");
    expect(entry?.outcome).toBe("success");
    expect((entry?.meta as { candidates?: unknown[] })?.candidates?.length).toBeGreaterThan(0);
  });

  it("the overriding registration does not hand back the candidates as if they were news", async () => {
    /**
     * `possibleDuplicates` comes back EMPTY on an override, and that is deliberate: the clerk has
     * already looked at that list and said no. Re-serving it would be the product arguing with a
     * decision it just asked a human to make.
     */
    const res = await post("/api/v1/patients", tokenAdmin, HOST, branchA)
      .send({ ...body(TWIN), force: true })
      .expect(201);

    expect(res.body.data.possibleDuplicates).toEqual([]);
  });

  it("force on a registration that was never blocked is simply ignored", async () => {
    // `force` is not a privilege escalation on its own — the permission check only runs when
    // there was something to override. A clerk whose form always sends `force: false|true` must
    // not be refused for registering somebody new.
    const res = await post("/api/v1/patients", tokenReception, HOST, branchA)
      .send({ ...body({ name: "Unblocked Force", gender: "female" }), force: true })
      .expect(201);

    expect(res.body.data.patient.uhid).toMatch(/\S/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. MERGE — the only thing that removes a duplicate, and it deletes nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("folding one chart into another", () => {
  let survivorId = "";
  let survivorUhid = "";
  let duplicateId = "";
  let duplicateUhid = "";

  beforeAll(async () => {
    const p: Person = { name: "Merge Subject", gender: "female", dob: "1966-08-08" };
    const first = await register(p);
    survivorId = first.id;
    survivorUhid = first.uhid;

    const forced = await post("/api/v1/patients", tokenAdmin, HOST, branchA)
      .send({ ...body(p), force: true })
      .expect(201);
    duplicateId = forced.body.data.patient.id as string;
    duplicateUhid = forced.body.data.patient.uhid as string;
  });

  it("refuses to merge a record into itself", async () => {
    const res = await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId, duplicateId: survivorId, reason: "same record, by mistake" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("merges, and returns both sides", async () => {
    const res = await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId, duplicateId, reason: "same patient, confirmed at desk 3" })
      .expect(200);

    expect(res.body.data.survivor.id).toBe(survivorId);
    expect(res.body.data.merged.id).toBe(duplicateId);
    expect(res.body.data.merged.status).toBe("merged");
    expect(res.body.data.merged.mergedInto).toBe(survivorId);
  });

  it("keeps the merged chart, and its UHID still resolves", async () => {
    /**
     * The merged UHID is already out in the world — on a wristband, a lab slip, a discharge
     * summary, an insurance claim. A lookup by that number must still answer, or those documents
     * become unverifiable. Nothing is deleted, ever.
     */
    const byId = await get(`/api/v1/patients/${duplicateId}`, tokenAdmin, HOST, branchA).expect(
      200,
    );
    expect(byId.body.data.status).toBe("merged");
    expect(byId.body.data.mergedInto).toBe(survivorId);

    const byUhid = await get(
      `/api/v1/patients/by-uhid/${duplicateUhid}`,
      tokenAdmin,
      HOST,
      branchA,
    ).expect(200);
    expect(byUhid.body.data.id).toBe(duplicateId);
  });

  it("hides the merged chart from the register, without losing it", async () => {
    // To a clerk a merged record is not a patient, it is an artifact of a mistake already
    // corrected — so it is filtered by DEFAULT, and findable when asked for by name.
    const active = await get(
      `/api/v1/patients?q=${duplicateUhid}`,
      tokenAdmin,
      HOST,
      branchA,
    ).expect(200);
    expect(active.body.data).toEqual([]);

    const merged = await get(
      `/api/v1/patients?q=${duplicateUhid}&status=merged`,
      tokenAdmin,
      HOST,
      branchA,
    ).expect(200);
    expect((merged.body.data as { id: string }[]).map((p) => p.id)).toContain(duplicateId);
  });

  it("no longer offers the merged chart as a duplicate candidate", async () => {
    /**
     * `findCandidates` filters on `status: "active"`. Offering a chart that has already been
     * resolved would send the clerk back to a record nobody should be adding to — and it would
     * make the merge look like it had not worked.
     */
    const res = await post("/api/v1/patients/check-duplicates", tokenAdmin, HOST, branchA)
      .send({ name: "Merge Subject", gender: "female", dob: "1966-08-08" })
      .expect(200);

    const ids = (res.body.data as { patient: { id: string } }[]).map((c) => c.patient.id);
    expect(ids).toContain(survivorId);
    expect(ids).not.toContain(duplicateId);
  });

  it("refuses to merge a record that has already been merged", async () => {
    const res = await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId, duplicateId, reason: "trying the same merge twice" })
      .expect(409);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("refuses to build a chain by merging INTO a merged record", async () => {
    /**
     * A → B → C means every consumer re-pointing references has to walk a linked list, one of
     * which will one day contain a cycle. Merge into the record that is actually alive.
     */
    const third = await post("/api/v1/patients", tokenAdmin, HOST, branchA)
      .send({
        ...body({ name: "Merge Subject", gender: "female", dob: "1966-08-08" }),
        force: true,
      })
      .expect(201);

    const res = await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({
        survivorId: duplicateId,
        duplicateId: third.body.data.patient.id,
        reason: "merging into a record that is itself merged",
      })
      .expect(409);

    expect(res.body.error.code).toBe("HMS-STATE-001");
    expect(res.body.error.details.mergeInto).toBe(survivorId);
  });

  it("records the merge, with the reason the operator typed", async () => {
    const entries = await inTenant(tenant, async () => {
      const connection = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
      });
      return connection.collection("auditLogs").find({ action: "patient.merged" }).toArray();
    });

    const entry = entries.find((e) => (e.meta as { mergedId?: string })?.mergedId === duplicateId);
    expect(entry, "a merge with no audit entry is a merge nobody can question").toBeDefined();
    expect((entry?.meta as { reason?: string })?.reason).toBe("same patient, confirmed at desk 3");
    expect((entry?.meta as { survivorUhid?: string })?.survivorUhid).toBe(survivorUhid);
  });

  it("is refused to somebody without patient:merge", async () => {
    await post("/api/v1/patients/merge", tokenReception, HOST, branchA)
      .send({ survivorId, duplicateId, reason: "a receptionist should not reach this" })
      .expect(403);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE BOUNDARIES — one decision with opposite signs.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the MPI reaches across sites, and stops at the hospital", () => {
  const TRAVELLER: Person = {
    name: "Travelling Patient",
    gender: "male",
    dob: "1988-11-19",
    phone: "9800000200",
  };

  let hereId = "";
  let otherId = "";

  beforeAll(async () => {
    hereId = (await register(TRAVELLER, tokenAdmin, branchA)).id;
  });

  it("refuses a second chart at the OTHER SITE — detection is not the guarantee, prevention is", async () => {
    /**
     * `branchIsolation.int.test.ts` §18 proves the check-duplicates ENDPOINT sees across branches.
     * This is the half that matters at the desk: `POST /patients` at Chennai must REFUSE the
     * person Hyderabad already registered. A patient's identity is tenant-level — one UHID across
     * every branch, treatable anywhere — so a per-site MPI would hand the same human a second
     * chart every time they walked into a different building.
     */
    const res = await post("/api/v1/patients", tokenAdmin, HOST, branchB)
      .send(body(TRAVELLER))
      .expect(409);

    expect(res.body.error.code).toBe("HMS-PAT-002");
    expect(await chartsNamed(TRAVELLER.name)).toBe(1);
  });

  it("and a branch-CONFINED clerk at the other site is refused the same way", async () => {
    /**
     * The account with the least coverage in the product (UAT plan FD-SEC-002). A user BOUND to
     * Chennai — rather than a hospital-wide user who selected it — must still meet the MPI. If
     * the binding narrowed the candidate search, a confined desk would be the one place in the
     * hospital that can quietly mint a second UHID.
     */
    await createUserWithRole(tenant, `chennai@${SLUG}.test`, "RECEPTIONIST", [branchB]);
    const confined = await login(HOST, `chennai@${SLUG}.test`);

    const res = await post("/api/v1/patients", confined, HOST).send(body(TRAVELLER)).expect(409);

    expect(res.body.error.code).toBe("HMS-PAT-002");
    const candidates = res.body.error.details.candidates as CandidatePayload[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(await chartsNamed(TRAVELLER.name)).toBe(1);
  });

  it("lets the OTHER hospital register the same person, with its own UHID", async () => {
    /**
     * The positive control, and it runs BEFORE the isolation assertion on purpose. "No candidates
     * came back" from a hospital that holds no patients is a test that passes on an empty
     * database and proves nothing — the classic vacuous pass. Registering here first means the
     * row genuinely exists on both sides when isolation is asserted below.
     *
     * Two hospitals do treat the same human, and neither may be told their patient already exists
     * somewhere they cannot see.
     */
    const res = await post("/api/v1/patients", tokenOtherAdmin, HOST_OTHER)
      .send(body(TRAVELLER))
      .expect(201);

    otherId = res.body.data.patient.id as string;
    expect(res.body.data.patient.uhid).toMatch(/\S/);
    expect(res.body.data.possibleDuplicates).toEqual([]);
    expect(await chartsNamed(TRAVELLER.name, other)).toBe(1);
    expect(await chartsNamed(TRAVELLER.name, tenant)).toBe(1);
  });

  it("offers each hospital only its OWN chart — the same person, two databases", async () => {
    // Separate databases (ADR-0005). The MPI reads `getTenantDb()`, and this is the test that
    // fails if it ever reads anything wider. Asserted in both directions, on rows that both exist.
    const criteria = {
      name: TRAVELLER.name,
      gender: "male",
      dob: TRAVELLER.dob,
      phone: TRAVELLER.phone,
    };

    const here = await post("/api/v1/patients/check-duplicates", tokenAdmin, HOST, branchA)
      .send(criteria)
      .expect(200);
    const hereIds = (here.body.data as { patient: { id: string } }[]).map((c) => c.patient.id);
    expect(hereIds).toContain(hereId);
    expect(hereIds).not.toContain(otherId);

    const there = await post("/api/v1/patients/check-duplicates", tokenOtherAdmin, HOST_OTHER)
      .send(criteria)
      .expect(200);
    const thereIds = (there.body.data as { patient: { id: string } }[]).map((c) => c.patient.id);
    expect(thereIds).toContain(otherId);
    expect(thereIds).not.toContain(hereId);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. TWO OPEN VISITS CANNOT BECOME ONE PATIENT
 * ──────────────────────────────────────────────────────────────────────────── */

describe("two open visits cannot become one patient", () => {
  /**
   * A department to route visits to. `startEncounter` needs a doctor OR a department depending on
   * the tenant's `encounterPolicy.routing`, and this suite has neither — it has never opened a
   * visit before.
   */
  let departmentId = "";

  beforeAll(async () => {
    const res = await post("/api/v1/departments", tokenAdmin, HOST, branchA)
      .send({ name: "General Medicine", code: "GEN-MERGE", kind: "clinical" })
      .expect(201);
    departmentId = res.body.data.id as string;
  });

  /** Opens a visit and returns its id. */
  async function openVisit(patientId: string): Promise<string> {
    const res = await post("/api/v1/encounters", tokenAdmin, HOST, branchA)
      .send({ patientId, departmentId, reason: "fever" })
      .expect(201);
    return res.body.data.encounter.id as string;
  }

  async function statusOf(patientId: string): Promise<string> {
    const res = await get(`/api/v1/patients/${patientId}`, tokenAdmin, HOST, branchA).expect(200);
    return res.body.data.status as string;
  }

  /**
   * ── WHAT THIS REFUSAL IS PROTECTING ─────────────────────────────────────────
   * `one_open_encounter_per_patient` allows a patient at most one open encounter. Re-pointing the
   * duplicate's visit onto a survivor who already has one is E11000 — raised inside the merge
   * fan-out, AFTER the bills, notes, doses and coding have already moved and the patient is
   * already marked `merged`. The job then retries into the same collision forever and the
   * survivor holds everything except the visit history.
   *
   * It is also the commonest merge there is: one walk-in registered twice on a morning with a
   * visit started on each. So the merge is refused before the first write instead.
   */
  it("refuses the merge, and says which two visits are in the way", async () => {
    const survivor = await register({ name: "Sunil Open", gender: "male", phone: "9440500001" });
    const duplicate = await register({ name: "Sunil Openn", gender: "male", phone: "9440500002" });
    const survivorVisit = await openVisit(survivor.id);
    const duplicateVisit = await openVisit(duplicate.id);

    const res = await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId: survivor.id, duplicateId: duplicate.id, reason: "same person" })
      .expect(409);

    expect(res.body.error.code).toBe("HMS-PAT-003");
    // Both encounters named: a clerk has to know WHICH visits to go and close.
    expect(res.body.error.details.survivorEncounterId).toBe(survivorVisit);
    expect(res.body.error.details.duplicateEncounterId).toBe(duplicateVisit);
    expect(String(res.body.error.details.hint)).toMatch(/close or cancel/i);
  });

  it("changes nothing at all — the refusal is before the first write", async () => {
    const survivor = await register({ name: "Latha Open", gender: "male", phone: "9440500003" });
    const duplicate = await register({ name: "Lathaa Open", gender: "male", phone: "9440500004" });
    await openVisit(survivor.id);
    await openVisit(duplicate.id);

    await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId: survivor.id, duplicateId: duplicate.id, reason: "same person" })
      .expect(409);

    // Still two live charts. A half-applied merge is the thing this whole guard exists to prevent,
    // so "it was refused" is not enough — the duplicate must still be usable.
    expect(await statusOf(duplicate.id)).toBe("active");
    expect(await statusOf(survivor.id)).toBe("active");

    // And no audit entry claiming a merge happened.
    const entries = await inTenant(tenant, async () => {
      const res = await get(
        "/api/v1/audit?action=patient.merged&limit=100",
        tokenAdmin,
        HOST,
        branchA,
      );
      return (res.body.data as { resourceId: string }[]) ?? [];
    });
    expect(entries.some((e) => e.resourceId === survivor.id)).toBe(false);
  });

  it("merges normally when only ONE of the two has a visit open", async () => {
    /**
     * The control, and the more important half: the guard must refuse the collision WITHOUT
     * refusing the ordinary case. One open visit moving to the survivor is exactly what a merge is
     * for, and a guard that blocked it would be worse than the bug.
     */
    const survivor = await register({ name: "Ganesh Solo", gender: "male", phone: "9440500005" });
    const duplicate = await register({ name: "Ganeshh Solo", gender: "male", phone: "9440500006" });
    const duplicateVisit = await openVisit(duplicate.id);

    await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId: survivor.id, duplicateId: duplicate.id, reason: "same person" })
      .expect(200);

    expect(await statusOf(duplicate.id)).toBe("merged");

    /**
     * The visit itself is NOT asserted here, and the omission is deliberate. Re-pointing happens on
     * the merge EVENT, which travels through the outbox to a worker this suite does not run — so a
     * `patientId` read back now would still name the duplicate, and asserting otherwise would only
     * prove the test had learned to run the relay. That the encounter follows the survivor is
     * proven where the event is dispatched for real: `patientMergeCoverage.int.test.ts` §2,
     * "encounters follows the surviving patient".
     *
     * What matters here is narrower, and is exactly what the guard could get wrong: ONE open visit
     * must not be refused.
     */
    expect(duplicateVisit).toBeTruthy();
  });

  it("merges normally when NEITHER has a visit open", async () => {
    const survivor = await register({ name: "Priya None", gender: "male", phone: "9440500007" });
    const duplicate = await register({ name: "Priyaa None", gender: "male", phone: "9440500008" });

    await post("/api/v1/patients/merge", tokenAdmin, HOST, branchA)
      .send({ survivorId: survivor.id, duplicateId: duplicate.id, reason: "same person" })
      .expect(200);

    expect(await statusOf(duplicate.id)).toBe("merged");
  });

  it("has the guard actually registered — not merely written", () => {
    /**
     * The bug class this repository keeps meeting: a capability wired to nothing. A guard that
     * `app.ts` forgot to register would make every assertion above pass except the first two, and
     * those would fail as "the merge succeeded" — which reads like a product change, not a missing
     * line of composition. This says it plainly instead.
     */
    expect(registeredMergeGuards()).toContain("open-visit");
  });
});
