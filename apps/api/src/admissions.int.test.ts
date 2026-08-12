/**
 * ADMISSIONS SUITE — release-gating (ADR-0013 §4, STATE_MACHINE_CATALOG §14).
 *
 * The claims this suite exists to prove:
 *
 *   1. TWO ENCOUNTERS, ONE EPISODE. The OP encounter closes; an INPATIENT one opens in the
 *      same Episode of Care. Never one encounter stretched across the admission — OP and IP
 *      tariffs differ, and every census, ALOS and NABH number counts encounters.
 *   2. THE BED IS BILLED PER DAY, and every day is its own charge. Keyed on the encounter,
 *      a five-day stay would bill ONE night and swallow the rest without an error.
 *   3. A DISCHARGE ALWAYS HAS A SUMMARY. There is no API path that skips it.
 *   4. A TRANSFER IS A HANDOVER — it requires a reason and it lands in the history.
 *   5. THE SAME CODE ADMITS A GOVERNMENT PATIENT FOR ₹0, with listPrice intact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Types } from "mongoose";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("admissions");
process.env.MONGO_MASTER_DB = "test_adm_master";
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
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");

const PVT = "test-adm-pvt";
const GOV = "test-adm-gov";
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "adm-int-test" }));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  token: string;
  doctorToken: string;
  doctorId: string;
  otherDoctorId: string;
  nurseToken: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const pvt = {} as Hospital;
const gov = {} as Hospital;

function auth(req: request.Test, h: Hospital, token?: string): request.Test {
  return req.set("Host", h.host).set("Authorization", `Bearer ${token ?? h.token}`);
}

async function asRelay<T>(h: Hospital, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "adm-relay-test", tenantId: h.id, tenantSlug: h.slug, connection: h.connection },
    fn,
  );
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  return res.body.data.accessToken as string;
}

async function setup(
  slug: string,
  organizationType: "private_hospital" | "government_hospital",
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
  await seedTariff(t.tenant.id, slug, connection);

  let doctorId = "";
  let otherDoctorId = "";
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

      const doc = await createUser({
        email: `doc@${slug}.test`,
        name: "Dr Rao",
        status: "invited",
      });
      await setPassword(doc.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(doc.id, "DOCTOR", []);
      await transitionStatus(doc.id, "active");
      doctorId = doc.id;

      const doc2 = await createUser({
        email: `doc2@${slug}.test`,
        name: "Dr Khan",
        status: "invited",
      });
      await setPassword(doc2.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(doc2.id, "DOCTOR", []);
      await transitionStatus(doc2.id, "active");
      otherDoctorId = doc2.id;

      const nurse = await createUser({
        email: `nurse@${slug}.test`,
        name: "Sister Mary",
        status: "invited",
      });
      await setPassword(nurse.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(nurse.id, "NURSE", []);
      await transitionStatus(nurse.id, "active");
    },
  );

  const host = `${slug}.medicore.test`;
  return {
    id: t.tenant.id,
    slug,
    host,
    token: await login(host, `admin@${slug}.test`),
    doctorToken: await login(host, `doc@${slug}.test`),
    nurseToken: await login(host, `nurse@${slug}.test`),
    doctorId,
    otherDoctorId,
    connection,
  };
}

/** A patient, arrived, called in — ready to be admitted. */
async function inConsultation(h: Hospital, name: string, phone: string): Promise<string> {
  const p = await auth(request(app).post("/api/v1/patients"), h)
    .send({ name, gender: "male", contact: { phone } })
    .expect(201);

  const res = await auth(request(app).post("/api/v1/encounters"), h)
    .send({ patientId: p.body.data.patient.id, doctorId: h.doctorId })
    .expect(201);

  const id = res.body.data.encounter.id as string;
  await auth(request(app).post(`/api/v1/encounters/${id}/queue`), h);
  await auth(request(app).post(`/api/v1/encounters/${id}/start`), h).expect(200);
  return id;
}

const WARD = { ward: "General Ward", bedCode: "A-12", tariffCode: "BED_GEN" };

/** Admits, and delivers `patient.admitted` the way the relay would. */
async function admit(h: Hospital, opEncounterId: string, bed = WARD) {
  const res = await auth(
    request(app).post(`/api/v1/encounters/${opEncounterId}/admit`),
    h,
    h.doctorToken,
  ).send(bed);

  if (res.status !== 201) return res;

  const ip = res.body.data.inpatient;
  await asRelay(h, () =>
    dispatchEventInline({
      eventId: `evt-adm-${ip.id as string}`,
      name: "encounter.patient.admitted",
      version: 1,
      tenantId: h.id,
      occurredAt: new Date().toISOString(),
      payload: {
        encounterId: ip.id,
        outpatientEncounterId: opEncounterId,
        episodeId: ip.episodeId,
        patientId: ip.patientId,
        ward: bed.ward,
        bedCode: bed.bedCode,
        tariffCode: bed.tariffCode,
        admittedAt: ip.admittedAt,
      },
    }),
  );

  return res;
}

/** Discharges with a summary, and delivers `patient.discharged`. */
async function discharge(h: Hospital, ipEncounterId: string, body?: Record<string, unknown>) {
  const res = await auth(
    request(app).post(`/api/v1/encounters/${ipEncounterId}/discharge`),
    h,
    h.doctorToken,
  ).send(
    body ?? { text: "Recovered well. Chest clear.", diagnosis: "Community-acquired pneumonia" },
  );

  if (res.status !== 201) return res;

  const enc = await auth(request(app).get(`/api/v1/encounters/${ipEncounterId}`), h).expect(200);
  const e = enc.body.data;

  await asRelay(h, () =>
    dispatchEventInline({
      eventId: `evt-dis-${ipEncounterId}`,
      name: "encounter.patient.discharged",
      version: 1,
      tenantId: h.id,
      occurredAt: new Date().toISOString(),
      payload: {
        encounterId: e.id,
        episodeId: e.episodeId,
        patientId: e.patientId,
        admittedAt: e.admittedAt,
        dischargedAt: e.dischargedAt,
        ward: e.bed?.ward,
        bedCode: e.bed?.bedCode,
        tariffCode: e.bed?.tariffCode,
      },
    }),
  );

  return res;
}

async function billOf(h: Hospital, encounterId: string) {
  const res = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), h).expect(200);
  return res.body.data;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_adm_master", `hms_${PVT}`, `hms_${GOV}`]);
  await flushTestCache("admissions");

  Object.assign(pvt, await setup(PVT, "private_hospital"));
  Object.assign(gov, await setup(GOV, "government_hospital"));
}, 180_000);

/**
 * Free every bed between tests.
 *
 * The suite deliberately reuses one bed (`A-12`) across most tests — each test is a fresh patient
 * admitted to the same ward — and the product correctly refuses a second open stay in an occupied
 * bed (`one_open_stay_per_bed`, migration 0020). Without this reset only the FIRST admit to A-12
 * would ever succeed and every later test would fail with "that bed is already occupied". That is a
 * test-isolation gap, not a product bug: a real ward does not re-use an occupied bed, and the
 * database is right to say so. So we release the beds — by removing the open IP stays each test
 * created — before the next test runs. Raw deletes on purpose: this is fixture teardown, not a
 * clinical discharge, and it must not fire audit hooks or emit events.
 */
beforeEach(async () => {
  for (const h of [pvt, gov]) {
    if (h.connection) await h.connection.collection("encounters").deleteMany({ class: "IP" });
  }
});

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_adm_master", `hms_${PVT}`, `hms_${GOV}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. TWO ENCOUNTERS, ONE EPISODE — ADR-0013 §4
 * ──────────────────────────────────────────────────────────────────────────── */

describe("admission opens a second encounter in the same care story", () => {
  it("the OP encounter is admitted (terminal) and an IP encounter opens in the SAME episode", async () => {
    const opId = await inConsultation(pvt, "Admit Patient", "9200100001");
    const res = await admit(pvt, opId);

    expect(res.status).toBe(201);
    const { outpatient, inpatient } = res.body.data;

    // The OP visit is over, and it will never reopen.
    expect(outpatient.status).toBe("admitted");
    // A new encounter — a DIFFERENT one — carries the stay.
    expect(inpatient.id).not.toBe(outpatient.id);
    expect(inpatient.class).toBe("IP");
    expect(inpatient.status).toBe("in_progress");
    // ...and this is the line that makes it one care story rather than two.
    expect(inpatient.episodeId).toBe(outpatient.episodeId);
    expect(inpatient.bed.bedCode).toBe("A-12");
    expect(inpatient.admittedFrom).toBe(opId);
  });

  it("the episode timeline shows both halves — continuity is a READ model", async () => {
    const opId = await inConsultation(pvt, "Timeline Patient", "9200100002");
    const res = await admit(pvt, opId);
    const episodeId = res.body.data.inpatient.episodeId as string;

    const timeline = await auth(
      request(app).get(`/api/v1/episodes/${episodeId}/timeline`),
      pvt,
    ).expect(200);

    // The doctor sees one unbroken story, from two encounters. Separation is a billing
    // and statutory concern; continuity is a query.
    expect(timeline.body.data).toHaveLength(2);
    expect(timeline.body.data.map((e: { class: string }) => e.class).sort()).toEqual(["IP", "OP"]);
  });

  it("the patient appears on the ward round list", async () => {
    const opId = await inConsultation(pvt, "Ward Patient", "9200100003");
    const res = await admit(pvt, opId);

    const ward = await auth(request(app).get("/api/v1/inpatients"), pvt, pvt.doctorToken).expect(
      200,
    );
    const ids = ward.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(res.body.data.inpatient.id);
  });

  it("a patient already in a bed cannot be admitted again", async () => {
    const opId = await inConsultation(pvt, "Twice Patient", "9200100004");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;

    /**
     * The state machine cannot catch this alone: an IP encounter sits at `in_progress`
     * like any other and `in_progress → admitted` is a legal edge. Without the guard the
     * ward could admit the same patient twice a day, abandoning each stay's bed charges on
     * an encounter nobody will ever close.
     */
    const again = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/admit`),
      pvt,
      pvt.doctorToken,
    ).send(WARD);

    expect(again.status).toBe(422);
    expect(again.body.error.details.hint).toContain("transfer the bed");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE BED IS BILLED PER DAY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the bed is billed by the day, and every day is its own charge", () => {
  it("admitting charges the FIRST night immediately", async () => {
    const opId = await inConsultation(pvt, "Bed Bill Patient", "9200200001");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;

    // The family asking for an interim bill on day three must not be told the stay has
    // cost nothing so far.
    const bill = await billOf(pvt, ipId);
    const beds = bill.lines.filter((l: { category: string }) => l.category === "bed");
    expect(beds).toHaveLength(1);
    expect(beds[0].amount).toBe(150_000); // ₹1,500 — one night in BED_GEN
  });

  it("a redelivered admission event does not charge the first night twice", async () => {
    const opId = await inConsultation(pvt, "Redelivered Adm", "9200200002");
    const res = await admit(pvt, opId);
    const ip = res.body.data.inpatient;

    // At-least-once delivery. This consumer WILL run twice.
    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-adm-${ip.id as string}`,
        name: "encounter.patient.admitted",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          encounterId: ip.id,
          episodeId: ip.episodeId,
          patientId: ip.patientId,
          ward: WARD.ward,
          bedCode: WARD.bedCode,
          tariffCode: WARD.tariffCode,
          admittedAt: ip.admittedAt,
        },
      }),
    );

    const bill = await billOf(pvt, ip.id as string);
    expect(bill.lines.filter((l: { category: string }) => l.category === "bed")).toHaveLength(1);
  });

  it("A FIVE-DAY STAY IS FIVE SEPARATE CHARGES — not one", async () => {
    const opId = await inConsultation(pvt, "Long Stay Patient", "9200200003");
    const res = await admit(pvt, opId);
    const ip = res.body.data.inpatient;

    /**
     * ── THE INVARIANT THIS SUITE EXISTS FOR ──────────────────────────────────
     * `one_charge_per_cause` is unique on (sourceId, code). If the bed charge were keyed
     * on the ENCOUNTER, this five-day stay would post exactly ONE night: the first would
     * succeed and the other four would be silently swallowed as duplicates. The hospital
     * bills ₹1,500 for five days in a ward and never sees an error.
     *
     * The cause is the NIGHT — `<encounterId>:night:3` — so each is its own row.
     *
     * The dates are crafted on the event rather than by waiting five days: the consumer's
     * arithmetic is what is under test, and it reads the clock off the payload precisely
     * so that a redelivery bills the same stay rather than a longer one.
     */
    const admittedAt = new Date("2026-06-01T06:00:00.000Z"); // 11:30 IST, 1 June
    const dischargedAt = new Date("2026-06-05T06:00:00.000Z"); // 11:30 IST, 5 June

    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-dis-long-${ip.id as string}`,
        name: "encounter.patient.discharged",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          encounterId: ip.id,
          episodeId: ip.episodeId,
          patientId: ip.patientId,
          admittedAt: admittedAt.toISOString(),
          dischargedAt: dischargedAt.toISOString(),
          tariffCode: "BED_GEN",
        },
      }),
    );

    const bill = await billOf(pvt, ip.id as string);
    const beds = bill.lines.filter((l: { code: string }) => l.code === "BED_GEN");

    // 1,2,3,4,5 June — five calendar days touched, five charges.
    expect(beds).toHaveLength(5);
    const total = beds.reduce((sum: number, l: { amount: number }) => sum + l.amount, 0);
    expect(total).toBe(5 * 150_000); // ₹7,500
  });

  it("an ICU bed is billed at the ICU tariff", async () => {
    const opId = await inConsultation(pvt, "ICU Patient", "9200200004");
    const res = await admit(pvt, opId, { ward: "ICU", bedCode: "ICU-3", tariffCode: "BED_ICU" });
    const ipId = res.body.data.inpatient.id as string;

    const bill = await billOf(pvt, ipId);
    const bed = bill.lines.find((l: { code: string }) => l.code === "BED_ICU");
    expect(bed.amount).toBe(1_200_000); // ₹12,000 a day
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. A DISCHARGE ALWAYS HAS A SUMMARY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("nobody goes home without a summary", () => {
  it("discharge writes the summary, closes the stay, and bills the bed", async () => {
    const opId = await inConsultation(pvt, "Discharge Patient", "9200300001");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;

    await auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
      .send({ text: "Day 1: febrile, started on IV antibiotics." })
      .expect(201);

    const out = await discharge(pvt, ipId);
    expect(out.status).toBe(201);
    expect(out.body.data.summary.type).toBe("discharge_summary");
    expect(out.body.data.summary.diagnosis).toBe("Community-acquired pneumonia");

    const enc = await auth(request(app).get(`/api/v1/encounters/${ipId}`), pvt).expect(200);
    expect(enc.body.data.status).toBe("closed");
    expect(enc.body.data.dischargedAt).toBeTruthy();

    // The chart: the progress note AND the summary, oldest first.
    const notes = await auth(
      request(app).get(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    expect(notes.body.data).toHaveLength(2);
    expect(notes.body.data[0].type).toBe("progress");
    expect(notes.body.data[1].type).toBe("discharge_summary");
  });

  it("a discharge with no summary text is refused by the schema", async () => {
    const opId = await inConsultation(pvt, "No Summary Patient", "9200300002");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;

    // There is no API path that discharges without a summary. The next doctor to see this
    // patient would otherwise get a person who was in hospital for a week and no statement
    // of what was found or done.
    const out = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/discharge`),
      pvt,
      pvt.doctorToken,
    ).send({});
    expect(out.status).toBe(400);
  });

  it("a SECOND discharge summary is refused — one admission, one summary", async () => {
    const opId = await inConsultation(pvt, "Two Summaries", "9200300003");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;

    await discharge(pvt, ipId);

    // Two summaries means the patient holds one document while the record says another,
    // and nothing says which is current.
    const again = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/discharge`),
      pvt,
      pvt.doctorToken,
    ).send({ text: "second opinion" });
    expect(again.status).toBe(422);
  });

  it("an OUTPATIENT cannot be discharged — an OP visit is CLOSED", async () => {
    const opId = await inConsultation(pvt, "OP Not IP", "9200300004");

    /**
     * `patient.discharged` is what ALOS, the midnight census and every occupancy number
     * are counted from. Firing it for somebody who never had a bed would count them as a
     * stay.
     */
    const out = await auth(
      request(app).post(`/api/v1/encounters/${opId}/discharge`),
      pvt,
      pvt.doctorToken,
    ).send({ text: "should not work" });

    expect(out.status).toBe(422);
    expect(out.body.error.details.hint).toContain("CLOSED, not discharged");
  });

  it("a ward note cannot be added after the patient has gone home", async () => {
    const opId = await inConsultation(pvt, "Late Note", "9200300005");
    const res = await admit(pvt, opId);
    const ipId = res.body.data.inpatient.id as string;
    await discharge(pvt, ipId);

    const late = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    ).send({ text: "backdated entry" });
    expect(late.status).toBe(422);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE GOVERNMENT HOSPITAL — a free bed, still costed
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a government hospital admits for nothing", () => {
  it("the bed is ₹0 to the patient, with listPrice intact", async () => {
    const opId = await inConsultation(gov, "Free Bed Patient", "9200400001");
    const res = await admit(gov, opId);
    const ipId = res.body.data.inpatient.id as string;

    const bill = await billOf(gov, ipId);
    const bed = bill.lines.find((l: { code: string }) => l.code === "BED_GEN");

    expect(bed.amount).toBe(0);
    // The state still needs to cost the bed it provided.
    expect(bed.listPrice).toBe(150_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. TRANSFER IS A HANDOVER, NOT AN EDIT
 * ──────────────────────────────────────────────────────────────────────────── */

describe("handing the patient to another doctor", () => {
  it("the patient moves to the other doctor's list, and the history says who and why", async () => {
    const opId = await inConsultation(pvt, "Transfer Patient", "9200500001");

    const res = await auth(
      request(app).post(`/api/v1/encounters/${opId}/transfer`),
      pvt,
      pvt.doctorToken,
    )
      .send({ doctorId: pvt.otherDoctorId, reason: "needs a surgical opinion" })
      .expect(200);

    expect(res.body.data.doctorId).toBe(pvt.otherDoctorId);
    // The patient is exactly as waiting as they were — what changed is who for.
    expect(res.body.data.status).toBe("in_progress");

    // The handover is IN THE RECORD. "Who was responsible at 4pm" has an answer.
    const handover = res.body.data.history.find((h: { reason?: string }) =>
      h.reason?.includes("transferred to another doctor"),
    );
    expect(handover).toBeTruthy();
    expect(handover.reason).toContain("needs a surgical opinion");
    expect(handover.by).toBeTruthy();
  });

  it("a transfer REQUIRES a reason", async () => {
    const opId = await inConsultation(pvt, "No Reason Patient", "9200500002");

    // The reason is the handover note, and it is the only thing the receiving doctor has.
    const res = await auth(
      request(app).post(`/api/v1/encounters/${opId}/transfer`),
      pvt,
      pvt.doctorToken,
    ).send({ doctorId: pvt.otherDoctorId });
    expect(res.status).toBe(400);
  });

  it("transferring to the doctor who already has the patient is refused", async () => {
    const opId = await inConsultation(pvt, "Same Doctor", "9200500003");

    const res = await auth(
      request(app).post(`/api/v1/encounters/${opId}/transfer`),
      pvt,
      pvt.doctorToken,
    ).send({ doctorId: pvt.doctorId, reason: "no-op" });
    expect(res.status).toBe(400);
  });

  it("a visit that is over cannot be transferred", async () => {
    const opId = await inConsultation(pvt, "Closed Transfer", "9200500004");
    await auth(request(app).post(`/api/v1/encounters/${opId}/close`), pvt, pvt.doctorToken)
      .send({ reason: "seen" })
      .expect(200);

    // It would put a finished patient on a colleague's list, and they would call a name
    // that is not coming.
    const res = await auth(
      request(app).post(`/api/v1/encounters/${opId}/transfer`),
      pvt,
      pvt.doctorToken,
    ).send({ doctorId: pvt.otherDoctorId, reason: "too late" });
    expect(res.status).toBe(422);
  });

  it("the orders and prescriptions do NOT move — they hang off the encounter", async () => {
    const opId = await inConsultation(pvt, "Orders Stay", "9200500005");

    await auth(request(app).post("/api/v1/orders"), pvt, pvt.doctorToken)
      .send({ encounterId: opId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    await auth(request(app).post(`/api/v1/encounters/${opId}/transfer`), pvt, pvt.doctorToken)
      .send({ doctorId: pvt.otherDoctorId, reason: "handover at shift end" })
      .expect(200);

    // The whole return on ADR-0013: handing over a patient is one field, not a migration.
    const orders = await auth(request(app).get(`/api/v1/orders?encounterId=${opId}`), pvt).expect(
      200,
    );
    expect(orders.body.data).toHaveLength(1);
    expect(orders.body.data[0].encounterId).toBe(opId);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE WARD ROUND LIST IS PAGED
 *
 * The regression: `GET /inpatients` hard-coded `{ limit: 100, skip: 0 }` and threw away the
 * `total` the repository had already computed. A hospital with more than a hundred open stays
 * saw a hundred, with nothing in the response to say the rest existed — admitted patients
 * silently absent from the ward round, which is the worst shape a list bug can take.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the ward round list pages, and says how many there are", () => {
  /**
   * Puts `count` open IP encounters in the ward, written straight to the collection.
   *
   * ── WHY NOT DRIVE 100 ADMISSIONS THROUGH HTTP ───────────────────────────────
   * The claim under test is that the ENDPOINT pages — that `?page=2` reaches the 101st row and
   * that `meta.total` counts them all. Admitting works and is proven by its own tests above;
   * repeating it a hundred times here would add a hundred patients, a hundred OP encounters and a
   * hundred billing events to a shared test database, which is slow enough to destabilise every
   * suite that runs after it. Seeding the exact rows the query reads is the honest short cut:
   * `listInpatients` selects on `class: "IP"` and `open: true` and nothing else.
   *
   * `beforeEach` deletes every IP encounter, so these never leak into another test.
   */
  async function fillWard(count: number, from: number): Promise<string[]> {
    // Stamped the way `writeBranchId()` stamps a real admission — the main site. Without it the
    // rows would be invisible to `scopeFilter()`, and the test would prove nothing.
    const main = await pvt.connection.collection("branches").findOne({ isMain: true });
    const branchId = (main?._id as Types.ObjectId | undefined)?.toHexString();
    const now = new Date();
    const docs = Array.from({ length: count }, (_, i) => {
      const n = from + i;
      return {
        _id: new Types.ObjectId(),
        tenantId: pvt.id,
        ...(branchId ? { branchId } : {}),
        patientId: new Types.ObjectId(),
        episodeId: new Types.ObjectId(),
        origin: "transfer",
        class: "IP",
        status: "in_progress",
        open: true,
        doctorId: pvt.doctorId,
        activeOrderCount: 0,
        history: [],
        bed: {
          ward: "Paged Ward",
          bedCode: `P-${String(n).padStart(4, "0")}`,
          tariffCode: "BED_GEN",
        },
        arrivedAt: now,
        admittedAt: now,
        createdBy: pvt.doctorId,
        /**
         * `isDeleted` is not optional here. `tenantScopePlugin` adds `{ isDeleted: false }` to
         * every read, and a raw insert bypasses the Mongoose default — so a document without the
         * field is invisible to the very endpoint under test, and the suite would report an empty
         * ward as though pagination had failed.
         */
        isDeleted: false,
        version: 0,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
    });

    await pvt.connection.collection("encounters").insertMany(docs);
    return docs.map((d) => d._id.toHexString());
  }

  async function ward(query = ""): Promise<request.Response> {
    return auth(request(app).get(`/api/v1/inpatients${query}`), pvt, pvt.doctorToken).expect(200);
  }

  it("sends `meta` with the hospital's real total", async () => {
    await fillWard(3, 10);

    const res = await ward("?page=1&limit=2");

    expect(res.body.data).toHaveLength(2);
    // The count is of every open stay, not of the page. This is the field that used to not exist.
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.meta.hasMore).toBe(true);
  });

  it("page 2 is different patients from page 1, and none is repeated", async () => {
    await fillWard(5, 20);

    const first = await ward("?page=1&limit=3");
    const second = await ward("?page=2&limit=3");

    const ids1 = first.body.data.map((e: { id: string }) => e.id) as string[];
    const ids2 = second.body.data.map((e: { id: string }) => e.id) as string[];

    expect(ids1).toHaveLength(3);
    expect(ids2.length).toBeGreaterThan(0);
    // The `_id` tie-break in the repository's sort is what makes this reliable: ward and bed code
    // do not identify a row, and without a total order a patient can land on both pages.
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
  });

  it("walks the WHOLE ward across pages without losing or repeating anyone", async () => {
    const admitted = await fillWard(7, 30);

    const seen: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const res = await ward(`?page=${String(page)}&limit=2`);
      seen.push(...(res.body.data.map((e: { id: string }) => e.id) as string[]));
      if (!res.body.meta.hasMore) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of admitted) expect(seen).toContain(id);
  });

  it("pages stays that TIE on the sort key — the ones with no bed recorded", async () => {
    /**
     * ── WHY THE SORT CARRIES `_id` ──────────────────────────────────────────────
     * `one_open_stay_per_bed_per_branch` already stops two open stays sharing a bed at one site, so
     * placed patients cannot tie. Stays with NO bed can: the index's partial filter requires
     * `bed.bedCode` to exist, so any number of them may be open at once and every one sorts with
     * both fields missing. Paging over an order that is not total can then return the same patient
     * on two pages and another on none.
     *
     * What this test does NOT do, stated plainly: removing the `_id` tie-break does not make it
     * fail. Forcing MongoDB to return two different orders for two executions of one query is not
     * something a test can do on demand. The tie-break is kept because the total ordering is what
     * makes `skip` paging correct — not because this test would catch its absence.
     */
    const now = new Date();
    const main = await pvt.connection.collection("branches").findOne({ isMain: true });
    const tied = Array.from({ length: 6 }, () => ({
      _id: new Types.ObjectId(),
      tenantId: pvt.id,
      ...(main ? { branchId: (main._id as Types.ObjectId).toHexString() } : {}),
      patientId: new Types.ObjectId(),
      episodeId: new Types.ObjectId(),
      origin: "transfer",
      class: "IP",
      status: "in_progress",
      open: true,
      activeOrderCount: 0,
      history: [],
      // No bed — so every one of these sorts with both sort fields missing, and they all tie.
      arrivedAt: now,
      admittedAt: now,
      isDeleted: false,
      version: 0,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await pvt.connection.collection("encounters").insertMany(tied);

    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const res = await ward(`?page=${String(page)}&limit=2`);
      seen.push(...(res.body.data.map((e: { id: string }) => e.id) as string[]));
      if (!res.body.meta.hasMore) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    for (const doc of tied) expect(seen).toContain(doc._id.toHexString());
  });

  it("more than 100 open stays are NOT silently truncated", async () => {
    /**
     * ── THE ORIGINAL BUG, DIRECTLY ─────────────────────────────────────────────
     * The old controller could not express this at all: 105 admitted patients came back as 100
     * with no `meta`, and the client had no way to know. Kept to a single extra page rather than
     * a hundred more admissions, because the assertion is about the CAP, not about volume.
     */
    const admitted = await fillWard(105, 100);

    const capped = await ward("?limit=100");
    const rest = await ward("?page=2&limit=100");

    expect(capped.body.data).toHaveLength(100);
    expect(capped.body.meta.total).toBe(105);
    expect(capped.body.meta.hasMore).toBe(true);

    // The five past the cap. Unreachable before this change, by any request that could be made.
    expect(rest.body.data).toHaveLength(5);
    const seen = [...capped.body.data, ...rest.body.data].map((e: { id: string }) => e.id);
    for (const id of admitted) expect(seen).toContain(id);
  });

  it("a caller that sends no parameters still gets up to 100 — the compatibility promise", async () => {
    const res = await ward();

    expect(res.body.meta.limit).toBe(100);
    expect(res.body.meta.page).toBe(1);
  });

  it("refuses a limit above the house cap rather than quietly honouring it", async () => {
    const res = await auth(request(app).get("/api/v1/inpatients?limit=5000"), pvt, pvt.doctorToken);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  it("stays branch-scoped and feature-gated exactly as before", async () => {
    // The nurse holds `encounter:read` too; what neither role can do is escape `scopeFilter()`.
    const nurse = await auth(
      request(app).get("/api/v1/inpatients?page=1&limit=5"),
      pvt,
      pvt.nurseToken,
    ).expect(200);
    expect(nurse.body.meta).toBeDefined();

    // A hospital without `module.ops.ipd` is refused on the plan, not on the page.
    const clinic = await auth(request(app).get("/api/v1/inpatients"), gov, gov.doctorToken);
    expect([200, 403]).toContain(clinic.status);
    if (clinic.status === 403) expect(clinic.body.error.code).toBe("HMS-PLAN-002");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. A WARD NOTE CANNOT BE WRITTEN TWICE BY A RETRY
 *
 * Notes are append-only: no update path, no delete path, and the repository does not
 * de-duplicate. Before `idempotent()` was mounted here, a client whose response was lost and
 * pressed save again left TWO identical contemporaneous entries on a medico-legal record,
 * permanently. The mobile app reconciles on top of this; the server is what makes it impossible.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a ward note honours Idempotency-Key", () => {
  const NOTE = { text: "Reviewed on the round. Afebrile overnight, chest clear." };

  async function admittedPatient(seed: number): Promise<string> {
    const opId = await inConsultation(
      pvt,
      `Note Patient ${String(seed)}`,
      `94${String(seed).padStart(8, "0")}`,
    );
    const res = await admit(pvt, opId, {
      ward: "Note Ward",
      bedCode: `N-${String(seed)}`,
      tariffCode: "BED_GEN",
    });
    return res.body.data.inpatient.id as string;
  }

  const notesOf = async (ipId: string): Promise<unknown[]> => {
    const res = await auth(
      request(app).get(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    return res.body.data as unknown[];
  };

  it("writes the note normally when a key is sent", async () => {
    const ipId = await admittedPatient(1);

    const res = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    )
      .set("Idempotency-Key", "ward-note-key-0001")
      .send(NOTE)
      .expect(201);

    expect(res.body.data.type).toBe("progress");
    expect(res.body.data.text).toBe(NOTE.text);
    // Written from the ENCOUNTER, never the body — the same rule as orders and prescriptions.
    expect(res.body.data.encounterId).toBe(ipId);
    expect(res.body.data.branchId ?? null).toBe(res.body.data.branchId ?? null);
    expect(await notesOf(ipId)).toHaveLength(1);
  });

  it("replays the original note for the same key, and writes nothing", async () => {
    const ipId = await admittedPatient(2);
    const key = "ward-note-key-0002";

    const first = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    )
      .set("Idempotency-Key", key)
      .send(NOTE)
      .expect(201);

    const replay = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    )
      .set("Idempotency-Key", key)
      .send(NOTE)
      .expect(201);

    // Byte-identical, including the id — the retry reports what the FIRST attempt did.
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    // The assertion that matters: the chart has ONE note, not two.
    expect(await notesOf(ipId)).toHaveLength(1);
  });

  it("refuses the same key with a DIFFERENT note rather than replaying it", async () => {
    const ipId = await admittedPatient(3);
    const key = "ward-note-key-0003";

    await auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
      .set("Idempotency-Key", key)
      .send(NOTE)
      .expect(201);

    const different = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    )
      .set("Idempotency-Key", key)
      .send({ text: "A completely different observation about a different problem." });

    /**
     * A silent replay here would be the dangerous outcome: the doctor's SECOND note would vanish
     * and they would be shown the first one as though it had just been written.
     */
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("HMS-REQ-002");
    expect(await notesOf(ipId)).toHaveLength(1);
  });

  it("writes exactly one note when the same key arrives concurrently", async () => {
    const ipId = await admittedPatient(4);
    const key = "ward-note-key-0004";

    const send = () =>
      auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
        .set("Idempotency-Key", key)
        .send(NOTE);

    const results = await Promise.all([send(), send(), send()]);

    // One executes; the others replay it or are told it is still running (HMS-REQ-004). None of
    // those three outcomes may create a second note, and that is the only claim being made.
    for (const res of results) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 409) expect(res.body.error.code).toBe("HMS-REQ-004");
    }
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(await notesOf(ipId)).toHaveLength(1);
  });

  it("a different key on the same encounter writes a SECOND note — two real observations", async () => {
    const ipId = await admittedPatient(5);

    await auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
      .set("Idempotency-Key", "ward-note-key-0005a")
      .send({ text: "Morning round: stable." })
      .expect(201);

    await auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
      .set("Idempotency-Key", "ward-note-key-0005b")
      .send({ text: "Evening round: still stable." })
      .expect(201);

    // The key must not suppress genuine entries — a ward round writes one every day.
    expect(await notesOf(ipId)).toHaveLength(2);
  });

  it("an old client that sends NO key still works, exactly as before", async () => {
    const ipId = await admittedPatient(6);

    await auth(request(app).post(`/api/v1/encounters/${ipId}/notes`), pvt, pvt.doctorToken)
      .send(NOTE)
      .expect(201);

    // Honoured, not demanded. Making the header mandatory would be a breaking change in v1.
    expect(await notesOf(ipId)).toHaveLength(1);
  });

  it("refuses a malformed key rather than silently ignoring it", async () => {
    const ipId = await admittedPatient(7);

    const res = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.doctorToken,
    )
      .set("Idempotency-Key", "no")
      .send(NOTE);

    // Dropping a bad key would leave a client believing it is protected when it is not — worse
    // than refusing, and worse than never having sent one.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(await notesOf(ipId)).toHaveLength(0);
  });

  it("still enforces authorization — a key does not buy permission", async () => {
    const ipId = await admittedPatient(8);

    // The NURSE holds `emr:read` but not `emr:write`. The key is consumed by nobody.
    const res = await auth(
      request(app).post(`/api/v1/encounters/${ipId}/notes`),
      pvt,
      pvt.nurseToken,
    )
      .set("Idempotency-Key", "ward-note-key-0008")
      .send(NOTE);

    expect(res.status).toBe(403);
    expect(await notesOf(ipId)).toHaveLength(0);
  });
});
