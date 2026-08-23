/**
 * PROBLEM LIST SUITE — release-gating.
 *
 * The patient's longitudinal problem list: what is true of this person TODAY, as opposed to what
 * a clinician concluded at one visit (`consultation.diagnoses[]`) or how one visit was classified
 * for the register (`encounterCoding.codes[]`). Both of those still exist, still mean what they
 * meant, and are not touched by anything here. The claims this suite defends:
 *
 *   1. A PROBLEM IS THE PATIENT'S, NOT THE BRANCH'S. Recorded at one site, visible at another —
 *      the allergy argument, and the reason `problem.repository.ts` must never call
 *      `scopeFilter()`. Hospital-wide stops at the hospital: another tenant sees nothing.
 *   2. A CODE IS A REAL CODE OR THERE IS NO CODE. `problems.code` is a key into this hospital's
 *      ICD master, checked on the way in — unlike the free-text code on a consultation note,
 *      which is why the note's own code is carried over only when the master recognises it.
 *   3. PROMOTION IS A CLINICIAN'S ACT, FROM THE CONSULTATION. The note is the source; the
 *      promoted problem points back at the visit it came from. There is deliberately no route
 *      from the MRD coding panel — a coder revising a classification must not author a clinical
 *      statement about a patient.
 *   4. A PROBLEM IS RESOLVED, NEVER DELETED. The row survives, the active list does not show it,
 *      and resolving twice is refused rather than silently repeated.
 *   5. THE LIST FOLLOWS A MERGE. A problem left on a retired chart is a condition the surviving
 *      chart does not show, and the symptom is an absence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Types } from "mongoose";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("problems");
process.env.MONGO_MASTER_DB = "test_problem_master";
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
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const { EVENTS } = await import("./core/events/eventCatalog.js");

const SLUG = "test-problems";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
/** A second hospital, so "hospital-wide" can be shown to stop at the hospital. */
const RIVAL_SLUG = "test-problems-rival";
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const RIVAL_HOST = `${RIVAL_SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "problem-int-test" })));

let tenantId = "";
let connection: Awaited<ReturnType<typeof getTenantConnection>>;
let rivalTenantId = "";
let rivalConnection: Awaited<ReturnType<typeof getTenantConnection>>;

let adminToken = "";
let doctorToken = "";
/** A doctor rostered to the SECOND site only — the cross-branch reader. */
let siteBDoctorToken = "";
let receptionToken = "";
let rivalDoctorToken = "";
let rivalAdminToken = "";

let siteA = "";
let siteB = "";
let departmentId = "";
let rivalDepartmentId = "";

function req(
  method: "get" | "post" | "put",
  path: string,
  token: string,
  host = HOST,
  branch?: string,
): request.Test {
  const r = request(app)[method](path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return branch ? r.set("X-Active-Branch", branch) : r;
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${String(res.status)}`);
  return res.body.data.accessToken as string;
}

async function makeUser(
  email: string,
  name: string,
  role: string,
  branchIds: string[] = [],
): Promise<string> {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, branchIds);
  await transitionStatus(u.id, "active");
  return u.id;
}

let phoneSeq = 9_400_100_000;
function nextPhone(): string {
  phoneSeq += 1;
  return String(phoneSeq);
}

/**
 * Registers a patient. The branch is named explicitly because this hospital has TWO sites and a
 * hospital-wide admin who has selected none is correctly refused (HMS-BRANCH-001) — a patient
 * record has to belong somewhere. Nothing about the problem list depends on which site it is;
 * §4 exists to prove exactly that.
 */
async function registerPatient(
  name: string,
  host = HOST,
  token = adminToken,
  branch: string | undefined = siteA,
): Promise<string> {
  const res = await req("post", "/api/v1/patients", token, host, branch)
    .send({ name, gender: "female", contact: { phone: nextPhone() } })
    .expect(201);
  return res.body.data.patient.id as string;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_problem_master", DB, RIVAL_DB]);
  await flushTestCache("problems");

  const t = await provisionTenant({
    hospitalName: "Problem List Hospital",
    slug: SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
    maxBranches: 2,
  });
  tenantId = t.tenant.id;
  connection = await getTenantConnection({ id: t.tenant.id, databaseName: t.tenant.databaseName });

  const rival = await provisionTenant({
    hospitalName: "Rival Hospital",
    slug: RIVAL_SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
  });
  rivalTenantId = rival.tenant.id;
  rivalConnection = await getTenantConnection({
    id: rival.tenant.id,
    databaseName: rival.tenant.databaseName,
  });

  await runWithContext(
    { traceId: `setup-${SLUG}`, tenantId, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();
      await makeUser(`admin@${SLUG}.test`, "Admin", "TENANT_ADMIN");
    },
  );
  await runWithContext(
    {
      traceId: `setup-${RIVAL_SLUG}`,
      tenantId: rivalTenantId,
      tenantSlug: RIVAL_SLUG,
      connection: rivalConnection,
    },
    async () => {
      await seedRbac();
      await makeUser(`admin@${RIVAL_SLUG}.test`, "Admin", "TENANT_ADMIN");
      await makeUser(`doc@${RIVAL_SLUG}.test`, "Dr Other", "DOCTOR");
    },
  );

  adminToken = await login(HOST, `admin@${SLUG}.test`);
  rivalDoctorToken = await login(RIVAL_HOST, `doc@${RIVAL_SLUG}.test`);

  const branches = await req("get", "/api/v1/branches", adminToken).expect(200);
  siteA = (branches.body.data as { id: string }[])[0]?.id as string;
  siteB = (
    await req("post", "/api/v1/branches", adminToken)
      .send({ name: "Riverside", code: "RIV" })
      .expect(201)
  ).body.data.id as string;

  await runWithContext(
    { traceId: "setup-staff", tenantId, tenantSlug: SLUG, connection },
    async () => {
      await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR", [siteA]);
      await makeUser(`docb@${SLUG}.test`, "Dr Iyer", "DOCTOR", [siteB]);
      await makeUser(`front@${SLUG}.test`, "Front Desk", "RECEPTIONIST", [siteA]);
    },
  );

  doctorToken = await login(HOST, `doc@${SLUG}.test`);
  siteBDoctorToken = await login(HOST, `docb@${SLUG}.test`);
  receptionToken = await login(HOST, `front@${SLUG}.test`);

  departmentId = (
    await req("post", "/api/v1/departments", adminToken, HOST, siteA)
      .send({ name: "General Medicine", code: "GEN-PROB", kind: "clinical" })
      .expect(201)
  ).body.data.id as string;

  rivalAdminToken = await login(RIVAL_HOST, `admin@${RIVAL_SLUG}.test`);
  rivalDepartmentId = (
    await req("post", "/api/v1/departments", rivalAdminToken, RIVAL_HOST)
      .send({ name: "General Medicine", code: "GEN-RIV", kind: "clinical" })
      .expect(201)
  ).body.data.id as string;
}, 240_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_problem_master", DB, RIVAL_DB]);
}, 30_000);

/* ── fixtures ──────────────────────────────────────────────────────────────── */

/** Opens a visit at site A and writes a consultation note carrying `diagnoses`. */
async function visitWithNote(
  patientId: string,
  diagnoses: { text: string; code?: string; type: "provisional" | "final" }[],
): Promise<string> {
  const enc = await req("post", "/api/v1/encounters", adminToken, HOST, siteA)
    .send({ patientId, departmentId, reason: "fever" })
    .expect(201);
  const encounterId = enc.body.data.encounter.id as string;

  await req("put", `/api/v1/encounters/${encounterId}/consultation`, doctorToken, HOST, siteA)
    .send({ chiefComplaint: "fever, 4 days", diagnoses })
    .expect(200);

  return encounterId;
}

const listProblems = (patientId: string, token = doctorToken, host = HOST, branch = siteA) =>
  req("get", `/api/v1/patients/${patientId}/problems`, token, host, branch);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. ADDING A PROBLEM DIRECTLY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("1. a clinician adds a problem", () => {
  it("records it as active, coded against the hospital's ICD master", async () => {
    const patientId = await registerPatient("Problem One");

    const res = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Type 2 diabetes mellitus", code: "E11.9", onsetDate: "2021-04-01" })
      .expect(201);

    expect(res.body.data.title).toBe("Type 2 diabetes mellitus");
    expect(res.body.data.code).toBe("E11.9");
    expect(res.body.data.status).toBe("active");
    // The recorder is the authenticated caller, never a body field.
    expect(res.body.data.notedBy).toBeTruthy();
    expect(res.body.data.onsetDate).toContain("2021-04-01");
    // Added directly, so there is no visit to point back at.
    expect(res.body.data.sourceEncounterId).toBeUndefined();
  });

  /**
   * The uncoded case is not a degraded one. A real problem list carries entries nobody has coded
   * ("post-operative wound, left leg"), and refusing them would push the clinician back to a
   * free-text note where nothing can find the problem at all.
   */
  it("accepts a problem with no code at all", async () => {
    const patientId = await registerPatient("Problem Two");

    const res = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Chronic low back pain, cause unclear" })
      .expect(201);

    expect(res.body.data.code).toBeUndefined();
    expect(res.body.data.status).toBe("active");
  });

  /**
   * THE DIFFERENCE FROM `consultation.diagnoses[].code`, which is free text nobody checks. A
   * problem coded `J189` (no dot) looks coded on a screen and matches nothing in a register — a
   * wrong answer wearing the clothes of a right one.
   */
  it("refuses a code the ICD master does not know", async () => {
    const patientId = await registerPatient("Problem Three");

    const res = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Pneumonia", code: "J189" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(JSON.stringify(res.body.error.details)).toContain("J189");
  });

  it("refuses a problem against a patient who does not exist", async () => {
    const res = await req(
      "post",
      "/api/v1/patients/507f1f77bcf86cd799439011/problems",
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Anything" })
      .expect(404);

    // The patients module owns its own not-found error, and it is more specific than a 404.
    expect(res.body.error.code).toBe("HMS-PAT-001");
  });

  it("refuses the same CODED problem twice while it is active", async () => {
    const patientId = await registerPatient("Problem Four");
    const url = `/api/v1/patients/${patientId}/problems`;

    await req("post", url, doctorToken, HOST, siteA)
      .send({ title: "Essential hypertension", code: "I10" })
      .expect(201);
    const dup = await req("post", url, doctorToken, HOST, siteA).send({
      title: "Hypertension",
      code: "I10",
    });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("HMS-PROB-001");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. PROMOTION FROM THE CONSULTATION
 * ──────────────────────────────────────────────────────────────────────────── */

describe("2. promoting a consultation diagnosis", () => {
  it("copies the diagnosis onto the list and points back at the visit", async () => {
    const patientId = await registerPatient("Promote One");
    const encounterId = await visitWithNote(patientId, [
      { text: "Dengue fever", code: "A90", type: "final" },
    ]);

    const res = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(201);

    expect(res.body.data.title).toBe("Dengue fever");
    // The note's own code, kept because the master recognises it.
    expect(res.body.data.code).toBe("A90");
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.sourceEncounterId).toBe(encounterId);
    expect(res.body.data.patientId).toBe(patientId);
  });

  /**
   * The note's `code` is FREE TEXT — `consultation.model.ts` says so outright ("the doctor types
   * it if they know it"). Carrying it into a field that promises a real master key would put
   * unverifiable strings in the one place that promised verified ones. So it is dropped, and the
   * problem is honestly uncoded rather than falsely coded.
   */
  it("drops a note's free-text code the master does not recognise, keeping the problem uncoded", async () => {
    const patientId = await registerPatient("Promote Two");
    const encounterId = await visitWithNote(patientId, [
      { text: "Viral fever", code: "NOTACODE", type: "provisional" },
    ]);

    const res = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(201);

    expect(res.body.data.title).toBe("Viral fever");
    expect(res.body.data.code).toBeUndefined();
  });

  it("lets the clinician pick a real code at promotion time, overriding the note", async () => {
    const patientId = await registerPatient("Promote Three");
    const encounterId = await visitWithNote(patientId, [
      { text: "Community-acquired pneumonia", code: "GUESS", type: "final" },
    ]);

    const res = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0, code: "J18.9" })
      .expect(201);

    expect(res.body.data.code).toBe("J18.9");
  });

  it("refuses a code the master does not know, even at promotion", async () => {
    const patientId = await registerPatient("Promote Four");
    const encounterId = await visitWithNote(patientId, [{ text: "Dengue fever", type: "final" }]);

    const res = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0, code: "ZZ99.9" })
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("refuses an index the note does not have", async () => {
    const patientId = await registerPatient("Promote Five");
    const encounterId = await visitWithNote(patientId, [{ text: "Dengue fever", type: "final" }]);

    const res = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 3 })
      .expect(422);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("refuses a visit with no consultation note to promote from", async () => {
    const patientId = await registerPatient("Promote Six");
    const enc = await req("post", "/api/v1/encounters", adminToken, HOST, siteA)
      .send({ patientId, departmentId, reason: "review" })
      .expect(201);

    const res = await req(
      "post",
      `/api/v1/encounters/${enc.body.data.encounter.id as string}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(422);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  /**
   * ANOTHER HOSPITAL'S VISIT. `tenantScopePlugin` forces `tenantId` onto every query, so the
   * encounter is not hidden by a rule that could be forgotten — it does not exist for this
   * caller at all, and the consultation lookup answers 404 before any problem is written.
   */
  it("refuses promotion from another tenant's encounter", async () => {
    const rivalPatient = await registerPatient(
      "Rival Patient",
      RIVAL_HOST,
      rivalAdminToken,
      undefined,
    );
    const rivalEnc = await req("post", "/api/v1/encounters", rivalAdminToken, RIVAL_HOST)
      .send({ patientId: rivalPatient, departmentId: rivalDepartmentId, reason: "fever" })
      .expect(201);
    const rivalEncounterId = rivalEnc.body.data.encounter.id as string;
    await req(
      "put",
      `/api/v1/encounters/${rivalEncounterId}/consultation`,
      rivalDoctorToken,
      RIVAL_HOST,
    )
      .send({ diagnoses: [{ text: "Dengue fever", type: "final" }] })
      .expect(200);

    const res = await req(
      "post",
      `/api/v1/encounters/${rivalEncounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(404);

    expect(res.body.error.code).toBe("HMS-GEN-404");

    // And nothing was written on either side.
    expect(await connection.collection("problems").countDocuments({ tenantId })).toBeGreaterThan(0);
    expect(
      await rivalConnection.collection("problems").countDocuments({ tenantId: rivalTenantId }),
    ).toBe(0);
  });

  it("refuses promotion from an encounter that does not exist", async () => {
    const res = await req(
      "post",
      "/api/v1/encounters/507f1f77bcf86cd799439011/problems/promote",
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(404);

    expect(res.body.error.code).toBe("HMS-GEN-404");
  });

  /**
   * The consultation note itself is untouched by promotion. This is the whole architectural
   * claim: the note is the doctor's account of one visit and stays exactly as written, while the
   * problem list is a separate, patient-level statement derived from it.
   */
  it("leaves the consultation note exactly as it was", async () => {
    const patientId = await registerPatient("Promote Seven");
    const encounterId = await visitWithNote(patientId, [
      { text: "Dengue fever", code: "A90", type: "final" },
    ]);
    const before = await req(
      "get",
      `/api/v1/encounters/${encounterId}/consultation`,
      doctorToken,
      HOST,
      siteA,
    ).expect(200);

    await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(201);

    const after = await req(
      "get",
      `/api/v1/encounters/${encounterId}/consultation`,
      doctorToken,
      HOST,
      siteA,
    ).expect(200);

    expect(after.body.data.diagnoses).toEqual(before.body.data.diagnoses);
    expect(after.body.data.chiefComplaint).toBe(before.body.data.chiefComplaint);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE LIFECYCLE
 * ──────────────────────────────────────────────────────────────────────────── */

describe("3. active → resolved, and never deleted", () => {
  it("resolving keeps the row, records who and why, and drops it out of the active list", async () => {
    const patientId = await registerPatient("Lifecycle One");
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Pneumonia, unspecified organism", code: "J18.9" })
      .expect(201);
    const id = created.body.data.id as string;

    const resolved = await req("post", `/api/v1/problems/${id}/resolve`, doctorToken, HOST, siteA)
      .send({ reason: "Completed antibiotics, chest clear" })
      .expect(200);

    expect(resolved.body.data.status).toBe("resolved");
    expect(resolved.body.data.resolvedBy).toBeTruthy();
    expect(resolved.body.data.resolvedReason).toContain("chest clear");

    // Still on the record — the row was not removed.
    const list = await listProblems(patientId).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(id);
    expect(list.body.data[0].status).toBe("resolved");

    // And the database agrees: one row, not zero.
    expect(
      await connection
        .collection("problems")
        .countDocuments({ _id: new Types.ObjectId(id), tenantId }),
    ).toBe(1);
  });

  it("resolves without a reason — ordinary clinical progress needs no justification", async () => {
    const patientId = await registerPatient("Lifecycle Two");
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Acute gastroenteritis" })
      .expect(201);

    const res = await req(
      "post",
      `/api/v1/problems/${created.body.data.id as string}/resolve`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({})
      .expect(200);

    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.resolvedReason).toBeUndefined();
  });

  it("refuses to resolve an already-resolved problem", async () => {
    const patientId = await registerPatient("Lifecycle Three");
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Malaria" })
      .expect(201);
    const url = `/api/v1/problems/${created.body.data.id as string}/resolve`;

    await req("post", url, doctorToken, HOST, siteA).send({ reason: "cleared" }).expect(200);
    const again = await req("post", url, doctorToken, HOST, siteA).send({ reason: "again" });

    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("HMS-STATE-001");
  });

  it("lets a resolved condition be recorded again if it returns", async () => {
    const patientId = await registerPatient("Lifecycle Four");
    const url = `/api/v1/patients/${patientId}/problems`;

    const first = await req("post", url, doctorToken, HOST, siteA)
      .send({ title: "Pneumonia", code: "J18.9" })
      .expect(201);
    await req(
      "post",
      `/api/v1/problems/${first.body.data.id as string}/resolve`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ reason: "recovered" })
      .expect(200);

    // The partial unique index covers only ACTIVE rows, so the dead one does not block a real
    // recurrence — which is exactly the record a longitudinal list should be able to hold.
    await req("post", url, doctorToken, HOST, siteA)
      .send({ title: "Pneumonia (recurrence)", code: "J18.9" })
      .expect(201);
  });

  it("lists active problems before resolved ones", async () => {
    const patientId = await registerPatient("Lifecycle Five");
    const url = `/api/v1/patients/${patientId}/problems`;

    const old = await req("post", url, doctorToken, HOST, siteA)
      .send({ title: "Dengue fever", code: "A90" })
      .expect(201);
    await req(
      "post",
      `/api/v1/problems/${old.body.data.id as string}/resolve`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ reason: "recovered" })
      .expect(200);
    await req("post", url, doctorToken, HOST, siteA)
      .send({ title: "Essential hypertension", code: "I10" })
      .expect(201);

    const list = await listProblems(patientId).expect(200);
    expect(list.body.data.map((p: { status: string }) => p.status)).toEqual(["active", "resolved"]);
  });

  it("404s when resolving a problem that does not exist", async () => {
    const res = await req(
      "post",
      "/api/v1/problems/507f1f77bcf86cd799439011/resolve",
      doctorToken,
      HOST,
      siteA,
    )
      .send({})
      .expect(404);
    expect(res.body.error.code).toBe("HMS-GEN-404");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. REACH — the whole hospital, and no further
 * ──────────────────────────────────────────────────────────────────────────── */

describe("4. a problem list crosses branches", () => {
  /**
   * ══════════════════════════════════════════════════════════════════════════
   *  THE TEST THAT PROTECTS THE MISSING `scopeFilter()`.
   * ══════════════════════════════════════════════════════════════════════════
   * `emr:read` is declared `branch`-scoped, and the ONLY thing making this list hospital-wide is
   * that `problem.repository.ts` does not call `scopeFilter()`. That looks like an oversight to
   * anyone reading the repository next to its neighbours, and the natural "fix" — adding the call
   * — would silently halve the feature: a patient referred from one site to the other would
   * arrive with an empty list, which reads as "nothing wrong with them", not "we did not look".
   *
   * Falsified by adding `...scopeFilter()` to `listForPatient`: this test goes red.
   */
  it("is visible at a site that has never seen the patient", async () => {
    const patientId = await registerPatient("Reach Subject");
    await req("post", `/api/v1/patients/${patientId}/problems`, doctorToken, HOST, siteA)
      .send({ title: "Type 2 diabetes mellitus", code: "E11.9" })
      .expect(201);

    const atA = await listProblems(patientId).expect(200);
    expect(atA.body.data).toHaveLength(1);
    expect(atA.body.data[0].branchId).toBe(siteA);

    // A doctor rostered only to Riverside, who has never met this patient.
    const atB = await listProblems(patientId, siteBDoctorToken, HOST, siteB).expect(200);
    expect(
      atB.body.data,
      "the problem list did not follow the patient to the other site — has scopeFilter() been " +
        "added to problem.repository.ts?",
    ).toHaveLength(1);
    expect(atB.body.data[0].title).toBe("Type 2 diabetes mellitus");
  });

  it("can be added at one site and resolved at the other", async () => {
    const patientId = await registerPatient("Reach Two");
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Essential hypertension", code: "I10" })
      .expect(201);

    await req(
      "post",
      `/api/v1/problems/${created.body.data.id as string}/resolve`,
      siteBDoctorToken,
      HOST,
      siteB,
    )
      .send({ reason: "off medication, normotensive for a year" })
      .expect(200);
  });

  /**
   * Hospital-wide stops at the hospital. Asserted on the DATA rather than the status code: an
   * unknown patient id answers `200 []`, which leaks nothing — it is the same answer a real
   * patient with no problems gives.
   */
  it("does NOT reach another hospital", async () => {
    const patientId = await registerPatient("Reach Three");
    await req("post", `/api/v1/patients/${patientId}/problems`, doctorToken, HOST, siteA)
      .send({ title: "Dengue fever", code: "A90" })
      .expect(201);

    const acrossTenants = await req(
      "get",
      `/api/v1/patients/${patientId}/problems`,
      rivalDoctorToken,
      RIVAL_HOST,
    ).expect(200);
    expect(acrossTenants.body.data).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. WHO MAY DO THIS
 * ──────────────────────────────────────────────────────────────────────────── */

describe("5. the permission split", () => {
  it("refuses a receptionist, who holds no emr:read", async () => {
    const patientId = await registerPatient("Perm One");
    const res = await listProblems(patientId, receptionToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("refuses a receptionist writing one", async () => {
    const patientId = await registerPatient("Perm Two");
    const res = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      receptionToken,
      HOST,
      siteA,
    ).send({ title: "Anything" });
    expect(res.status).toBe(403);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE AUDIT TRAIL
 * ──────────────────────────────────────────────────────────────────────────── */

describe("6. every change is audited as PHI", () => {
  it("records the create and the resolve, and keeps the free-text reason out of the diff", async () => {
    const patientId = await registerPatient("Audit One");
    const created = await req(
      "post",
      `/api/v1/patients/${patientId}/problems`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ title: "Type 2 diabetes mellitus", code: "E11.9" })
      .expect(201);
    const id = created.body.data.id as string;

    await req("post", `/api/v1/problems/${id}/resolve`, doctorToken, HOST, siteA)
      .send({ reason: "diet controlled, HbA1c normal for two years" })
      .expect(200);

    const entries = await connection
      .collection("auditLogs")
      .find({ tenantId, resource: "problem", resourceId: id })
      .sort({ seq: 1 })
      .toArray();

    // Falsified by removing the auditPlugin from problem.model.ts: this goes red.
    expect(entries.length, "no audit entry was written for a problem").toBeGreaterThanOrEqual(2);
    for (const e of entries) expect(e.category).toBe("phi");
    expect(entries.some((e) => String(e.action).includes("created"))).toBe(true);

    /**
     * `resolvedReason` is in the plugin's `ignore` list, for the reason an allergy's `reaction`
     * is: the trail records THAT the list changed and by whom, and must not become a second copy
     * of the clinical detail behind a longer retention period than the record itself.
     */
    expect(JSON.stringify(entries)).not.toContain("HbA1c normal");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. THE LIST FOLLOWS A MERGE
 * ──────────────────────────────────────────────────────────────────────────── */

describe("7. a merged patient's problems move to the survivor", () => {
  /**
   * The generic proof — every registered collection, driven off `REPOINTED_PATIENT_REFERENCES` —
   * lives in `patientMergeCoverage.int.test.ts`, and `problems` joins it automatically. This is
   * the named case: a REAL problem, promoted through the real route, on two real patients.
   *
   * Falsified by removing `problemConsumers` from `eventConsumer.ts`: this goes red, and so does
   * the structural guard in the coverage suite.
   */
  it("moves a promoted problem from the duplicate chart onto the survivor", async () => {
    const survivorId = await registerPatient("Merge Survivor");
    const duplicateId = await registerPatient("Merge Duplicate");

    const encounterId = await visitWithNote(duplicateId, [
      { text: "Type 2 diabetes mellitus", code: "E11.9", type: "final" },
    ]);
    const promoted = await req(
      "post",
      `/api/v1/encounters/${encounterId}/problems/promote`,
      doctorToken,
      HOST,
      siteA,
    )
      .send({ diagnosisIndex: 0 })
      .expect(201);

    expect((await listProblems(survivorId).expect(200)).body.data).toEqual([]);

    await runWithContext(
      { traceId: "merge-problems", tenantId, tenantSlug: SLUG, connection },
      () =>
        dispatchEventInline({
          eventId: `evt-problem-merge-${String(Date.now())}`,
          name: EVENTS.PATIENTS_MERGED,
          version: 1,
          tenantId,
          occurredAt: new Date().toISOString(),
          payload: { survivorId, mergedId: duplicateId },
        }),
    );

    const onSurvivor = await listProblems(survivorId).expect(200);
    expect(onSurvivor.body.data).toHaveLength(1);
    expect(onSurvivor.body.data[0].id).toBe(promoted.body.data.id);
    expect(onSurvivor.body.data[0].title).toBe("Type 2 diabetes mellitus");
    // A merge is a pointer, not a cull: the row moved, it was not recreated or removed.
    expect(onSurvivor.body.data[0].sourceEncounterId).toBe(encounterId);
    expect((await listProblems(duplicateId).expect(200)).body.data).toEqual([]);
  });
});
