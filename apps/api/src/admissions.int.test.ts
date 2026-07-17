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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
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
