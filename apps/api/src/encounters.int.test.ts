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
import { listening } from "./test/appServer.js";
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
const { forgetSchemaReadiness } = await import("./core/db/schemaReadiness.js");

/** A GOVERNMENT hospital: walk-in entry, token at registration, department routing. */
const GOV = "test-enc-gov";
/** A PRIVATE hospital: appointments, token at check-in, doctor routing. */
const PVT = "test-enc-pvt";
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "enc-int-test" })));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  token: string;
  doctorId: string;
  patientId: string;
  /** Needed by the schema-safety block, which drops a real index on this tenant's own database. */
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
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
    connection,
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
    // A test must be ordered before the patient can be sent to wait for one: sending them with
    // nothing ordered strands them in a state no result will ever release. That guard is the
    // point of `activeOrderCount`, so this arrange step is the realistic path, not scaffolding.
    await auth(request(app).post("/api/v1/orders"), gov)
      .send({
        encounterId: first.body.data.encounter.id,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
      })
      .expect(201);
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

/* ────────────────────────────────────────────────────────────────────────────
 * 5. ARRIVING IS NOT BEING SEEN — the fact a signed document has to read
 *
 * ── WHY THE ENCOUNTER HAS TO ANSWER THIS ────────────────────────────────────
 * A visit is given its doctor at REGISTRATION, so `doctorId` means "who is this patient waiting
 * for". The OPD slip printed the doctor's scanned SIGNATURE off `doctorId` alone: a patient who
 * had paid the OP fee and was still in the waiting room went home holding a summary signed by a
 * doctor who had not met them.
 *
 * `seenAt` is the missing fact, derived in the repository from the encounter's own history so no
 * client re-derives it. The state machine makes it exact — `in_progress` is reachable only from
 * `arrived`/`in_queue`, and `closed`/`admitted` only THROUGH it — so its presence is equivalent
 * to "a doctor has taken this patient in", and that equivalence is what group 4 above pins.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an encounter records when the doctor actually saw the patient", () => {
  async function freshVisit(name: string, phone: string): Promise<string> {
    const patient = await auth(request(app).post("/api/v1/patients"), gov)
      .send({ name, gender: "male", contact: { phone } })
      .expect(201);
    const enc = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId: patient.body.data.patient.id, departmentId: gov.doctorId })
      .expect(201);
    return enc.body.data.encounter.id as string;
  }

  it("is ABSENT while the patient is only waiting", async () => {
    const id = await freshVisit("Waiting Warrier", "9000003001");

    const res = await auth(request(app).get(`/api/v1/encounters/${id}`), gov).expect(200);
    // The visit already knows its doctor — and that is exactly the trap. Waiting for someone is
    // not being seen by them, and only one of those two facts belongs over a signature line.
    expect(res.body.data.doctorId ?? res.body.data.departmentId).toBeTruthy();
    expect(res.body.data.status).toBe("in_queue");
    expect(res.body.data.seenAt).toBeUndefined();
  });

  it("appears the moment the doctor calls them in, and stays put afterwards", async () => {
    const id = await freshVisit("Called Kurup", "9000003002");

    const started = await auth(request(app).post(`/api/v1/encounters/${id}/start`), gov).expect(
      200,
    );
    const seenAt = started.body.data.seenAt as string;
    expect(seenAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(seenAt))).toBe(false);

    // A later transition must not restamp it: the patient was seen when they were seen, and a
    // slip printed after the lab results has to say so, not "seen just now".
    const closed = await auth(request(app).post(`/api/v1/encounters/${id}/close`), gov);
    if (closed.status === 200) expect(closed.body.data.seenAt).toBe(seenAt);
  });

  /**
   * The equivalence the OPD slip depends on, asserted against the machine rather than assumed.
   *
   * If a waiting patient could ever reach `closed` or `admitted` directly, a visit could finish
   * having never been `in_progress` — and `seenAt` would be absent on a completed consultation,
   * silently stripping the signature off a slip that had earned it. The state machine forbids
   * it; this test is what notices the day someone adds the edge.
   */
  it("cannot reach a finished state without going through the consultation", () => {
    for (const notYetSeen of ["planned", "arrived", "in_queue"] as const) {
      expect(canTransition(notYetSeen, "closed")).toBe(false);
      expect(canTransition(notYetSeen, "admitted")).toBe(false);
      expect(canTransition(notYetSeen, "awaiting_results")).toBe(false);
    }
    // And the one door in is the one `seenAt` is stamped from.
    expect(canTransition("in_queue", "in_progress")).toBe(true);
    expect(canTransition("arrived", "in_progress")).toBe(true);
  });
});

/**
 * OPEN-ENCOUNTER RUNTIME SCHEMA SAFETY.
 *
 * ── HERE THE INDEX IS NOT A GUARD, IT IS THE FEATURE ────────────────────────
 * `one_open_encounter_per_patient` (migration 0012) is what makes `startEncounter` RESUME a visit
 * instead of forking it. There is no read-before-write, by design — the service header says so:
 * "two desks registering the same patient at the same instant both read 'no open encounter' and
 * both write. Only the database can arbitrate that." The `catch` that hands the clerk back the
 * visit in progress only runs BECAUSE the insert threw.
 *
 * So without the index nothing throws, and the resume silently becomes a duplicate. Measured
 * against Mongo 7 on 2026-08-17: the same patient queued twice, two open encounters, and
 * recreating the index over the pair REFUSED (11000). Every duplicate also strands an EPISODE,
 * since `createEpisode` runs first inside the same transaction.
 */
describe("starting a visit refuses when the database cannot enforce one open encounter", () => {
  const OPEN_INDEX = "one_open_encounter_per_patient";

  async function dropOpenIndex(h: Hospital): Promise<void> {
    await h.connection.collection("encounters").dropIndex(OPEN_INDEX);
    forgetSchemaReadiness();
  }

  async function restoreOpenIndex(h: Hospital): Promise<void> {
    await h.connection.collection("encounters").createIndex(
      { tenantId: 1, patientId: 1 },
      {
        unique: true,
        partialFilterExpression: { open: { $eq: true } },
        background: true,
        name: OPEN_INDEX,
      },
    );
    forgetSchemaReadiness();
  }

  let phone = 9400500000;
  async function newPatient(h: Hospital, name: string): Promise<string> {
    phone += 1;
    const res = await auth(request(app).post("/api/v1/patients"), h)
      .send({ name, gender: "male", contact: { phone: String(phone) } })
      .expect(201);
    return res.body.data.patient.id as string;
  }

  /** Close whatever visit this patient is on, so the next test's patient pool stays clean. */
  async function close(h: Hospital, encounterId: string): Promise<void> {
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/close`), h).send({});
  }

  it("starts a visit normally while the invariant it rests on is armed", async () => {
    const patientId = await newPatient(gov, "Guard Normal");

    const res = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);

    expect(res.body.data.resumed).toBe(false);
    await close(gov, res.body.data.encounter.id as string);
  });

  it("answers 503 HMS-ENC-001 with Retry-After when the open-encounter index is gone", async () => {
    const patientId = await newPatient(gov, "Guard Refusal");

    await dropOpenIndex(gov);
    try {
      const res = await auth(request(app).post("/api/v1/encounters"), gov).send({
        patientId,
        departmentId: gov.doctorId,
      });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-ENC-001");
      expect(res.headers["retry-after"]).toBe("60");
      const missing = res.body.error.details.missing as { migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0012-encounters");
      expect(String(res.body.error.message)).toMatch(/paper/i);
    } finally {
      await restoreOpenIndex(gov);
    }
  });

  /**
   * Nothing is written — and the EPISODE matters as much as the encounter here, because
   * `createEpisode` runs first inside the transaction and a stranded episode is a care story with
   * no visit in it.
   */
  it("writes neither an encounter nor an episode when it refuses", async () => {
    const patientId = await newPatient(gov, "Guard No Write");

    const episodesBefore = await gov.connection.collection("episodes").countDocuments({});

    await dropOpenIndex(gov);
    try {
      await auth(request(app).post("/api/v1/encounters"), gov)
        .send({ patientId, departmentId: gov.doctorId })
        .expect(503);

      expect(await gov.connection.collection("encounters").countDocuments({ patientId })).toBe(0);
      expect(await gov.connection.collection("episodes").countDocuments({})).toBe(episodesBefore);
    } finally {
      await restoreOpenIndex(gov);
    }
  });

  it("starts visits again the moment the index is restored", async () => {
    const patientId = await newPatient(gov, "Guard Recovery");

    await dropOpenIndex(gov);
    const refused = await auth(request(app).post("/api/v1/encounters"), gov).send({
      patientId,
      departmentId: gov.doctorId,
    });
    expect(refused.status).toBe(503);

    await restoreOpenIndex(gov);
    const ok = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);
    await close(gov, ok.body.data.encounter.id as string);
  });

  /**
   * ── THE QUEUE MUST KEEP MOVING ────────────────────────────────────────────
   * Every other transition acts on an encounter that already exists and rests on nothing this
   * index provides. A hospital that could not move the patients already in its waiting room would
   * be worse off than one that merely cannot admit new ones — the people in front of the desk are
   * the ones with nowhere else to go.
   */
  it("does not block the queue, the consultation, or closing a visit already open", async () => {
    const patientId = await newPatient(gov, "Guard In Flight");
    const started = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);
    const encounterId = started.body.data.encounter.id as string;

    await dropOpenIndex(gov);
    try {
      // A new arrival is refused …
      const other = await newPatient(gov, "Guard Blocked Arrival");
      await auth(request(app).post("/api/v1/encounters"), gov)
        .send({ patientId: other, departmentId: gov.doctorId })
        .expect(503);

      // … while the patient already in the building is seen and sent home.
      await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), gov).expect(200);
      await auth(request(app).post(`/api/v1/encounters/${encounterId}/close`), gov)
        .send({})
        .expect(200);
    } finally {
      await restoreOpenIndex(gov);
    }
  });

  it("does not block reads — the queue and the chart stay legible", async () => {
    const patientId = await newPatient(gov, "Guard Reads");
    const started = await auth(request(app).post("/api/v1/encounters"), gov)
      .send({ patientId, departmentId: gov.doctorId })
      .expect(201);
    const encounterId = started.body.data.encounter.id as string;

    await dropOpenIndex(gov);
    try {
      await auth(request(app).get(`/api/v1/encounters/${encounterId}`), gov).expect(200);
      await auth(request(app).get("/api/v1/encounters?status=in_queue"), gov).expect(200);
    } finally {
      await restoreOpenIndex(gov);
    }
    await close(gov, encounterId);
  });

  /** Database-per-tenant (ADR-0005): the private hospital carries on regardless. */
  it("does not block a DIFFERENT hospital, whose own index is intact", async () => {
    const mine = await newPatient(gov, "Guard Isolation");
    const theirs = await newPatient(pvt, "Other Hospital Patient");

    await dropOpenIndex(gov);
    try {
      await auth(request(app).post("/api/v1/encounters"), gov)
        .send({ patientId: mine, departmentId: gov.doctorId })
        .expect(503);

      const ok = await auth(request(app).post("/api/v1/encounters"), pvt)
        .send({ patientId: theirs, doctorId: pvt.doctorId })
        .expect(201);
      await close(pvt, ok.body.data.encounter.id as string);
    } finally {
      await restoreOpenIndex(gov);
    }
  });

  /** An index on the right fields that is not unique enforces nothing. */
  it("fails CLOSED when the index exists but has stopped being unique", async () => {
    const patientId = await newPatient(gov, "Guard Not Unique");

    await gov.connection.collection("encounters").dropIndex(OPEN_INDEX);
    await gov.connection.collection("encounters").createIndex(
      { tenantId: 1, patientId: 1 },
      {
        partialFilterExpression: { open: { $eq: true } },
        background: true,
        name: OPEN_INDEX,
      },
    );
    forgetSchemaReadiness();
    try {
      const res = await auth(request(app).post("/api/v1/encounters"), gov).send({
        patientId,
        departmentId: gov.doctorId,
      });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-ENC-001");
    } finally {
      await gov.connection.collection("encounters").dropIndex(OPEN_INDEX);
      await restoreOpenIndex(gov);
    }
  });

  /**
   * `encounters` carries TWO declared invariants and this guard must answer for only one of them.
   * Losing the BED key cannot fork a visit — admission is protected separately (HMS-ADM-003).
   */
  it("still starts visits when the BED index is gone — that is a different capability", async () => {
    const patientId = await newPatient(gov, "Guard Other Index");

    await gov.connection.collection("encounters").dropIndex("one_open_stay_per_bed_per_branch");
    forgetSchemaReadiness();
    try {
      const res = await auth(request(app).post("/api/v1/encounters"), gov)
        .send({ patientId, departmentId: gov.doctorId })
        .expect(201);
      await close(gov, res.body.data.encounter.id as string);
    } finally {
      await gov.connection.collection("encounters").createIndex(
        { tenantId: 1, branchId: 1, "bed.ward": 1, "bed.bedCode": 1 },
        {
          unique: true,
          partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
          background: true,
          name: "one_open_stay_per_bed_per_branch",
        },
      );
      forgetSchemaReadiness();
    }
  });
});
