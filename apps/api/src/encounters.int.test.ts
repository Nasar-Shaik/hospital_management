/**
 * ENCOUNTERS SUITE — release-gating (Doc 02 E0, ADR-0013, STATE_MACHINE_CATALOG §14).
 *
 * Two properties dominate this module.
 *
 *   1. A WALK-IN IS NOT AN EXCEPTION. A patient can be registered, queued, seen and
 *      closed with no appointment anywhere in the story — because in a government
 *      hospital and a small clinic that is not an edge case, it is EVERY patient.
 *      The old model could not even issue them a token.
 *
 *   2. ONE OPEN ENCOUNTER PER PATIENT. A patient who goes to the lab and comes back
 *      keeps the same visit. Re-registering them fragments one visit into two — the
 *      census double-counts, the bill splits across records that no longer add up,
 *      and the doctor's history has a hole. It is enforced by a unique partial
 *      index, because two desks both read "no open encounter" and both write, and
 *      only the database can arbitrate that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("encounters");
process.env.MONGO_MASTER_DB = "test_enc_master";
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
const { canTransition } = await import("./modules/encounters/index.js");

/** A GOVERNMENT hospital: walk-in entry, token at registration, department routing. */
const GOV = "test-enc-gov";
/** A PRIVATE hospital: appointments, token at check-in, doctor routing. */
const PVT = "test-enc-pvt";
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "enc-int-test" }));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  token: string;
  doctorId: string;
  patientId: string;
}

const gov = {} as Hospital;
const pvt = {} as Hospital;

function auth(req: request.Test, h: Hospital): request.Test {
  return req.set("Host", h.host).set("Authorization", `Bearer ${h.token}`);
}

async function setupHospital(
  slug: string,
  organizationType: "government_hospital" | "private_hospital",
): Promise<Hospital> {
  const t = await provisionTenant({
    hospitalName: slug,
    slug,
    planCode: "PLAN_HOSPITAL",
    organizationType,
  });

  const connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });

  let doctorId = "";
  await runWithContext(
    { traceId: `setup-${slug}`, tenantId: t.tenant.id, tenantSlug: slug, connection },
    async () => {
      await seedRbac();

      const admin = await createUser({
        email: `admin@${slug}.test`,
        name: "Admin",
        status: "invited",
      });
      await setPassword(admin.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(admin.id, "TENANT_ADMIN", []);
      await transitionStatus(admin.id, "active");

      const doctor = await createUser({
        email: `doc@${slug}.test`,
        name: "Dr Rao",
        status: "invited",
      });
      await assignRoleByCode(doctor.id, "DOCTOR", []);
      await transitionStatus(doctor.id, "active");
      doctorId = doctor.id;
    },
  );

  const host = `${slug}.medicore.test`;
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email: `admin@${slug}.test`, password: PASSWORD });

  const h: Hospital = {
    id: t.tenant.id,
    slug,
    host,
    token: login.body.data.accessToken as string,
    doctorId,
    patientId: "",
  };

  const patient = await auth(request(app).post("/api/v1/patients"), h)
    .send({ name: `Patient ${slug}`, gender: "female", contact: { phone: "9000000123" } })
    .expect(201);
  h.patientId = patient.body.data.patient.id as string;

  return h;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_enc_master", `hms_${GOV}`, `hms_${PVT}`]);
  await flushTestCache("encounters");

  Object.assign(gov, await setupHospital(GOV, "government_hospital"));
  Object.assign(pvt, await setupHospital(PVT, "private_hospital"));
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_enc_master", `hms_${GOV}`, `hms_${PVT}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE WALK-IN — the journey that had no home before ADR-0013
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a government hospital runs a whole clinic with NO appointment book", () => {
  it("registers a walk-in and issues a token AT REGISTRATION, with no appointment anywhere", async () => {
    const res = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId: gov.patientId, departmentId: gov.doctorId, reason: "fever" })
      .expect(201);

    const encounter = res.body.data.encounter;

    // Walk-in is the DEFAULT origin. Nobody had to say so, and nobody had to invent
    // an appointment to make the patient exist.
    expect(encounter.origin).toBe("walk_in");
    expect(encounter.appointmentId).toBeUndefined();

    // `tokenIssuedAt: registration` (the government preset) — so the patient is IN
    // THE QUEUE the moment they are registered. There is no check-in desk to wait
    // for, because nothing was booked.
    expect(encounter.status).toBe("in_queue");
    expect(encounter.token).toBe(1);
  });

  it("the doctor sees their waiting patients, in token order", async () => {
    const res = await auth(request(app).get("/api/v1/encounters?queued=true"), gov).expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
    const tokens = (res.body.data as { token: number }[]).map((e) => e.token);
    expect([...tokens]).toEqual([...tokens].sort((a, b) => a - b));
  });

  it("tokens are issued atomically — 5 simultaneous walk-ins get 5 DIFFERENT numbers", async () => {
    // Two clerks at two desks must never both be told "token 42". A read-then-write
    // cannot promise that; the atomic $inc can. Same mechanism as the UHID.
    const patients = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        auth(request(app).post("/api/v1/patients"), gov)
          .send({
            name: `Rush ${String(i)}`,
            gender: "male",
            contact: { phone: `90000012${String(i)}` },
          })
          .expect(201),
      ),
    );

    const results = await Promise.all(
      patients.map((p) =>
        auth(request(app).post("/api/v1/encounters"), gov).send({
          patientId: p.body.data.patient.id,
          departmentId: gov.doctorId,
        }),
      ),
    );

    const tokens = results.map((r) => r.body.data.encounter.token as number);
    expect(new Set(tokens).size).toBe(5); // all distinct
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. ONE OPEN ENCOUNTER PER PATIENT — the anti-fragmentation invariant
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a patient cannot be in the building twice", () => {
  it("re-registering a patient who is ALREADY HERE resumes their visit — it does not create a second", async () => {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name: "Returning Rao", gender: "female", contact: { phone: "9000000777" } })
      .expect(201);
    const patientId = patient.body.data.patient.id as string;

    const first = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);

    // The patient goes to the lab. They are still MID-VISIT.
    await auth(
      request(app).post(`/api/v1/encounters/${first.body.data.encounter.id}/start`),
      gov,
    ).expect(200);
    await auth(
      request(app).post(`/api/v1/encounters/${first.body.data.encounter.id}/investigations`),
      gov,
    ).expect(200);

    // They come back. A clerk who cannot see that the visit is still open registers
    // them again — the single commonest data-quality disaster in an OPD.
    const second = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      // 200, not 201: nothing was created.
      .expect(200);

    expect(second.body.data.resumed).toBe(true);
    expect(second.body.data.encounter.id).toBe(first.body.data.encounter.id);
    // And they keep the number they were called by. A waiting room that renumbers
    // people is a riot.
    expect(second.body.data.encounter.token).toBe(first.body.data.encounter.token);
    expect(second.body.data.encounter.status).toBe("awaiting_results");
  });

  it("the patient CAN start a new visit once the old one is closed", async () => {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name: "Tomorrow Nair", gender: "male", contact: { phone: "9000000888" } })
      .expect(201);
    const patientId = patient.body.data.patient.id as string;

    const first = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);

    await auth(request(app).post(`/api/v1/encounters/${first.body.data.encounter.id}/start`), gov);
    await auth(request(app).post(`/api/v1/encounters/${first.body.data.encounter.id}/close`), gov)
      .send({})
      .expect(200);

    // A closed encounter must RELEASE the patient — `open` is unset, not set false.
    // A stored `false` would sit in the unique index and lock them out forever.
    const second = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);

    expect(second.body.data.resumed).toBe(false);
    expect(second.body.data.encounter.id).not.toBe(first.body.data.encounter.id);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. POLICY, NOT BRANCHES — the same code serves both hospitals
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the SAME code gives a private hospital a different journey", () => {
  it("a private hospital does NOT issue a token at registration — it waits for check-in", async () => {
    const res = await auth(request(app).post("/api/v1/encounters"), pvt)
      .send({ patientId: pvt.patientId, doctorId: pvt.doctorId, origin: "walk_in" })
      .expect(201);

    // `tokenIssuedAt: check_in` (the private preset). The patient has ARRIVED but is
    // not yet in the queue, and holds no number.
    expect(res.body.data.encounter.status).toBe("arrived");
    expect(res.body.data.encounter.token).toBeUndefined();

    // Same endpoint, same code, different hospital — driven entirely by the policy
    // its `organizationType` preset selected. No branch anywhere reads the type.
    const queued = await auth(
      request(app).post(`/api/v1/encounters/${res.body.data.encounter.id}/queue`),
      pvt,
    ).expect(200);

    expect(queued.body.data.status).toBe("in_queue");
    expect(queued.body.data.token).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE STATE MACHINE (STATE_MACHINE_CATALOG §14)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the encounter state machine", () => {
  it("a patient sent for tests can COME BACK to the same encounter", () => {
    // The transition that stops a hospital re-registering the returning patient.
    expect(canTransition("in_progress", "awaiting_results")).toBe(true);
    expect(canTransition("awaiting_results", "in_progress")).toBe(true);
  });

  it("admission is TERMINAL for this encounter — the story continues in a new one", () => {
    // ADR-0013 §4: the OP encounter closes; an inpatient encounter opens in the same
    // Episode. Two encounters can be joined into a timeline; one can never be split.
    expect(canTransition("in_progress", "admitted")).toBe(true);
    expect(canTransition("admitted", "in_progress")).toBe(false);
    expect(canTransition("admitted", "closed")).toBe(false);
  });

  it("refuses an illegal transition rather than corrupting the visit", async () => {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name: "Illegal Move", gender: "female", contact: { phone: "9000000999" } })
      .expect(201);

    const enc = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId: patient.body.data.patient.id, departmentId: gov.doctorId })
      .expect(201);

    // in_queue → investigations is not an edge: you cannot send someone for tests
    // that no doctor has ordered.
    const res = await auth(
      request(app).post(`/api/v1/encounters/${enc.body.data.encounter.id}/investigations`),
      gov,
    ).expect(422);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("cancellation requires a reason", async () => {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name: "No Reason", gender: "male", contact: { phone: "9000001111" } })
      .expect(201);

    const enc = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId: patient.body.data.patient.id, departmentId: gov.doctorId })
      .expect(201);

    await auth(request(app).post(`/api/v1/encounters/${enc.body.data.encounter.id}/cancel`), gov)
      .send({})
      .expect(400);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE EPISODE — how an admission will inherit the OP history
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the episode of care is the care story", () => {
  it("every encounter carries an episode, and the timeline reads over it", async () => {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name: "Episode Menon", gender: "female", contact: { phone: "9000002222" } })
      .expect(201);

    const enc = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId: patient.body.data.patient.id, departmentId: gov.doctorId })
      .expect(201);

    const episodeId = enc.body.data.encounter.episodeId as string;
    expect(episodeId).toBeTruthy();

    const timeline = await auth(
      request(app).get(`/api/v1/episodes/${episodeId}/timeline`),
      gov,
    ).expect(200);

    // Today it is one encounter. When admission lands it will be two — the OP visit
    // and the inpatient stay — and the doctor will see one unbroken story while the
    // hospital still bills and counts them separately (ADR-0013 §4).
    expect(timeline.body.data).toHaveLength(1);
    expect(timeline.body.data[0].id).toBe(enc.body.data.encounter.id);
  });
});
