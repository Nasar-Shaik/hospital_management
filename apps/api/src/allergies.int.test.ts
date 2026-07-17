/**
 * ALLERGIES SUITE — release-gating.
 *
 * The store the prescribing safety check screens against. The claims this suite defends:
 *
 *   1. AN ALLERGY IS RECORDED AS A CATALOGUE CODE, never free text — a typed "penicilin"
 *      is a note a machine can never match, and a check that silently never fires is the
 *      whole failure mode this feature exists to prevent.
 *   2. ONE ACTIVE ROW PER ALLERGEN — the same allergy entered twice is one fact, not two,
 *      and the database refuses the duplicate.
 *   3. AN ALLERGY IS RULED OUT, NEVER DELETED — a refuted allergy stops firing the check
 *      but stays on the record, with who ruled it out and why.
 *   4. THE PERMISSION SPLIT HOLDS — a pharmacist READS the list (they are the last check
 *      before a drug is handed over) but cannot EDIT a finding they did not make.
 *
 * The end-to-end BLOCK — an allergy refusing a signature — is proved in the prescriptions
 * suite, where the sign flow lives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("allergies");
process.env.MONGO_MASTER_DB = "test_allergy_master";
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

const SLUG = "test-allergy";
const DB = `hms_${SLUG}`;
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "allergy-int-test" }));

let tenantId = "";
let adminToken = "";
let doctorToken = "";
let pharmacistToken = "";
let connection: Awaited<ReturnType<typeof getTenantConnection>>;

function auth(req: request.Test, token: string): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${token}`);
}

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
    .send({ email, password: PASSWORD });
  return res.body.data.accessToken as string;
}

async function makeUser(email: string, name: string, role: string): Promise<void> {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, []);
  await transitionStatus(u.id, "active");
}

/** Registers a patient and returns their id. Registration is reception/admin work, not a
 * doctor's — the doctor holds `allergy:manage`, not `patient:create`. */
async function registerPatient(name: string, phone: string): Promise<string> {
  const res = await auth(request(app).post("/api/v1/patients"), adminToken)
    .send({ name, gender: "male", contact: { phone } })
    .expect(201);
  return res.body.data.patient.id as string;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_allergy_master", DB]);
  await flushTestCache("allergies");

  const t = await provisionTenant({
    hospitalName: "Allergy Test Hospital",
    slug: SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
  });
  tenantId = t.tenant.id;
  connection = await getTenantConnection({ id: t.tenant.id, databaseName: t.tenant.databaseName });

  await runWithContext(
    { traceId: `setup-${SLUG}`, tenantId, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();
      await makeUser(`admin@${SLUG}.test`, "Admin", "TENANT_ADMIN");
      await makeUser(`doc@${SLUG}.test`, "Dr Rao", "DOCTOR");
      await makeUser(`pharm@${SLUG}.test`, "Pharmacist Pat", "PHARMACIST");
    },
  );

  adminToken = await login(`admin@${SLUG}.test`);
  doctorToken = await login(`doc@${SLUG}.test`);
  pharmacistToken = await login(`pharm@${SLUG}.test`);
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_allergy_master", DB]);
}, 30_000);

/* ─────────────────────────────────────────────────────────────────────────── */

describe("recording an allergy", () => {
  it("records a catalogued allergen and returns its human label", async () => {
    const patientId = await registerPatient("Allergy One", "9300100001");

    const res = await auth(
      request(app).post(`/api/v1/patients/${patientId}/allergies`),
      doctorToken,
    )
      .send({ allergen: "penicillins", severity: "severe", reaction: "throat swelling" })
      .expect(201);

    expect(res.body.data.allergen).toBe("penicillins");
    expect(res.body.data.label).toBe("Penicillins");
    expect(res.body.data.severity).toBe("severe");
    expect(res.body.data.status).toBe("active");
    // The recorder is the authenticated caller, never a body field.
    expect(res.body.data.notedBy).toBeTruthy();
  });

  it("refuses an allergen that is not in the catalogue — it could never match a drug", async () => {
    const patientId = await registerPatient("Allergy Two", "9300100002");

    const res = await auth(
      request(app).post(`/api/v1/patients/${patientId}/allergies`),
      doctorToken,
    )
      .send({ allergen: "penicilin" }) // misspelt on purpose
      .expect(400);

    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("refuses a second ACTIVE row for the same allergen", async () => {
    const patientId = await registerPatient("Allergy Three", "9300100003");
    const url = `/api/v1/patients/${patientId}/allergies`;

    await auth(request(app).post(url), doctorToken).send({ allergen: "nsaids" }).expect(201);
    const dup = await auth(request(app).post(url), doctorToken).send({ allergen: "nsaids" });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("HMS-ALLERGY-001");
  });

  it("refuses recording against a patient who does not exist", async () => {
    const res = await auth(
      request(app).post(`/api/v1/patients/507f1f77bcf86cd799439011/allergies`),
      doctorToken,
    )
      .send({ allergen: "penicillins" })
      .expect(404);

    // The patients module owns its own not-found error, and it is more specific than a 404.
    expect(res.body.error.code).toBe("HMS-PAT-001");
  });
});

describe("ruling an allergy out", () => {
  it("refuting stops it being active but keeps it on the record, with the reason", async () => {
    const patientId = await registerPatient("Allergy Four", "9300100004");
    const url = `/api/v1/patients/${patientId}/allergies`;

    const created = await auth(request(app).post(url), doctorToken)
      .send({ allergen: "sulfonamides", severity: "moderate" })
      .expect(201);
    const id = created.body.data.id as string;

    await auth(request(app).post(`/api/v1/allergies/${id}/refute`), doctorToken)
      .send({ reason: "Formal challenge negative — no reaction" })
      .expect(200);

    const list = await auth(request(app).get(url), doctorToken).expect(200);
    const row = list.body.data.find((a: { id: string }) => a.id === id);
    expect(row.status).toBe("refuted");
    expect(row.refutedReason).toContain("challenge negative");
    // Still visible — the record of what was ruled out survives.
    expect(list.body.data).toHaveLength(1);
  });

  it("a refuted allergen can be re-recorded as active (the partial unique index allows it)", async () => {
    const patientId = await registerPatient("Allergy Five", "9300100005");
    const url = `/api/v1/patients/${patientId}/allergies`;

    const first = await auth(request(app).post(url), doctorToken)
      .send({ allergen: "macrolides" })
      .expect(201);
    await auth(request(app).post(`/api/v1/allergies/${first.body.data.id}/refute`), doctorToken)
      .send({ reason: "entered on the wrong patient" })
      .expect(200);

    // A fresh, genuine finding for the same class must not be blocked by the dead row.
    await auth(request(app).post(url), doctorToken).send({ allergen: "macrolides" }).expect(201);
  });

  it("refuting an already-refuted allergy is refused, not silently repeated", async () => {
    const patientId = await registerPatient("Allergy Six", "9300100006");
    const created = await auth(
      request(app).post(`/api/v1/patients/${patientId}/allergies`),
      doctorToken,
    )
      .send({ allergen: "opioids" })
      .expect(201);
    const id = created.body.data.id as string;
    const refute = `/api/v1/allergies/${id}/refute`;

    await auth(request(app).post(refute), doctorToken).send({ reason: "ruled out" }).expect(200);
    const again = await auth(request(app).post(refute), doctorToken).send({ reason: "again" });
    expect(again.status).toBe(422);
  });
});

describe("the permission split", () => {
  it("a pharmacist can READ the allergy list — they are the last check before hand-over", async () => {
    const patientId = await registerPatient("Allergy Seven", "9300100007");
    await auth(request(app).post(`/api/v1/patients/${patientId}/allergies`), doctorToken)
      .send({ allergen: "penicillins" })
      .expect(201);

    const res = await auth(
      request(app).get(`/api/v1/patients/${patientId}/allergies`),
      pharmacistToken,
    ).expect(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("a pharmacist may NOT record an allergy — a finding they did not make", async () => {
    const patientId = await registerPatient("Allergy Eight", "9300100008");
    const res = await auth(
      request(app).post(`/api/v1/patients/${patientId}/allergies`),
      pharmacistToken,
    ).send({ allergen: "penicillins" });
    expect(res.status).toBe(403);
  });
});
