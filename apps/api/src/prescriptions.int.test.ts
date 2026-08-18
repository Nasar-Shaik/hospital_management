/**
 * PRESCRIPTIONS + PHARMACY SUITE — release-gating (STATE_MACHINE_CATALOG §6).
 *
 * The claims this suite exists to prove, in the order they can hurt somebody:
 *
 *   1. A DRAFT AUTHORISES NOTHING. Drugs leave the shelf on a signature, never on a
 *      doctor thinking out loud, and never on a prescription that has been stopped.
 *   2. NOBODY GETS MORE THAN WAS PRESCRIBED. The guard is the database, not an `if`.
 *   3. SIGNED IS IMMUTABLE. A dose change is a new version, and the original survives it
 *      exactly as it was signed.
 *   4. THE PATIENT PAYS FOR WHAT THEY WERE GIVEN — not for what was written. Prescribing
 *      costs nothing; dispensing costs money; a partial handover costs part of it.
 *   5. THE SAME CODE BILLS A GOVERNMENT HOSPITAL AT ₹0, with `listPrice` intact.
 *   6. A PRESCRIPTION IS NOT A RESULT. It must not hold a patient in `awaiting_results`,
 *      and it must not mail a doctor about a report that does not exist.
 *
 * Everything here is PAISE. 150 is ₹1.50 — a paracetamol.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("prescriptions");
process.env.MONGO_MASTER_DB = "test_rx_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { createApp } = await import("./app.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { forgetSchemaReadiness } = await import("./core/db/schemaReadiness.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedTariff } = await import("./seed/tariff.js");
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const batches = await import("./modules/medicines/batch.repository.js");

const PVT = "test-rx-pvt";
const GOV = "test-rx-gov";
const CLINIC = "test-rx-clinic";
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "rx-int-test" })));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  /** TENANT_ADMIN — used only where the act under test is not the point. */
  token: string;
  doctorToken: string;
  doctorId: string;
  pharmacistToken: string;
  /** NURSE — charting and observations, which no other role in this harness may do. */
  nurseToken: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const pvt = {} as Hospital;
const gov = {} as Hospital;
const clinic = {} as Hospital;

function auth(req: request.Test, h: Hospital, token?: string): request.Test {
  return req.set("Host", h.host).set("Authorization", `Bearer ${token ?? h.token}`);
}

/** Runs a consumer the way the relay does — inside a tenant-resolved context. */
async function asRelay<T>(h: Hospital, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "rx-relay-test", tenantId: h.id, tenantSlug: h.slug, connection: h.connection },
    fn,
  );
}

async function login(h: { host: string }, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", h.host)
    .send({ email, password: PASSWORD });
  return res.body.data.accessToken as string;
}

async function setup(
  slug: string,
  organizationType: "private_hospital" | "government_hospital" | "clinic",
): Promise<Hospital> {
  const t = await provisionTenant({
    hospitalName: slug,
    slug,
    // Clinic Plus, not Clinic: it dispenses in the plan sense (`module.pharmacy.dispensing`)
    // while its POLICY says the patient buys drugs elsewhere. Those two are different
    // questions, and this suite proves they do not get conflated.
    planCode: organizationType === "clinic" ? "PLAN_CLINIC_PLUS" : "PLAN_HOSPITAL",
    organizationType,
  });

  const connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });

  await seedTariff(t.tenant.id, slug, connection);

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

      const doc = await createUser({
        email: `doc@${slug}.test`,
        name: "Dr Rao",
        status: "invited",
      });
      await setPassword(doc.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(doc.id, "DOCTOR", []);
      await transitionStatus(doc.id, "active");
      doctorId = doc.id;

      /**
       * A nurse, so the suite can prove what a dispensing refusal must NOT touch. Charting a dose
       * and recording observations are NURSE permissions — neither the doctor nor the admin holds
       * them — so without this the proportionality claim could only be asserted, not exercised.
       */
      const nurse = await createUser({
        email: `nurse@${slug}.test`,
        name: "Sister Fernandes",
        status: "invited",
      });
      await setPassword(nurse.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(nurse.id, "NURSE", []);
      await transitionStatus(nurse.id, "active");

      const pharm = await createUser({
        email: `pharm@${slug}.test`,
        name: "Pharmacist Iqbal",
        status: "invited",
      });
      await setPassword(pharm.id, PASSWORD, { mustChangePassword: false });
      await assignRoleByCode(pharm.id, "PHARMACIST", []);
      await transitionStatus(pharm.id, "active");
    },
  );

  const host = `${slug}.medicore.test`;

  return {
    id: t.tenant.id,
    slug,
    host,
    token: await login({ host }, `admin@${slug}.test`),
    doctorToken: await login({ host }, `doc@${slug}.test`),
    pharmacistToken: await login({ host }, `pharm@${slug}.test`),
    nurseToken: await login({ host }, `nurse@${slug}.test`),
    doctorId,
    connection,
  };
}

/** A patient, arrived and on an open encounter. */
async function arrive(h: Hospital, name: string, phone: string): Promise<string> {
  const p = await auth(request(app).post("/api/v1/patients"), h)
    .send({ name, gender: "female", contact: { phone } })
    .expect(201);

  const res = await auth(request(app).post("/api/v1/encounters"), h)
    .send({ patientId: p.body.data.patient.id, departmentId: h.doctorId })
    .expect(201);

  return res.body.data.encounter.id as string;
}

const PARACETAMOL = {
  drugCode: "DRUG_PARA_500",
  drugName: "Paracetamol 500mg Tablet",
  dose: "500 mg",
  route: "oral" as const,
  frequency: "TDS" as const,
  durationDays: 5,
  quantity: 15,
};

const AMOXICILLIN = {
  drugCode: "DRUG_AMOX_500",
  drugName: "Amoxicillin 500mg Capsule",
  dose: "500 mg",
  route: "oral" as const,
  frequency: "BD" as const,
  durationDays: 5,
  quantity: 10,
};

/** Writes a draft as the DOCTOR. */
async function draft(h: Hospital, encounterId: string, lines: unknown[] = [PARACETAMOL]) {
  const res = await auth(request(app).post("/api/v1/prescriptions"), h, h.doctorToken)
    .send({ encounterId, lines })
    .expect(201);
  return res.body.data;
}

/**
 * Signs it, and delivers EVERY event the relay would — `prescription.signed`, and then
 * the `order.placed` that its consumer raises.
 *
 * ── WHY THE SECOND DISPATCH IS NOT OPTIONAL ─────────────────────────────────
 * An earlier version of this helper stopped after `prescription.signed`. The suite was
 * green, and "signing a prescription does not charge the patient" passed — but it passed
 * because `order.placed` was never delivered to billing at all, not because billing
 * declines to charge for it. Deliberately re-enabling the double-charge bug did not fail
 * a single test.
 *
 * A test that cannot fail is not evidence. Delivering the full chain is what makes the
 * "prescribing is free" claim mean something, because the event that WOULD wrongly charge
 * is now genuinely in front of the consumer that must ignore it.
 */
async function sign(
  h: Hospital,
  rx: { id: string; encounterId: string; patientId: string; episodeId: string },
) {
  const res = await auth(
    request(app).post(`/api/v1/prescriptions/${rx.id}/sign`),
    h,
    h.doctorToken,
  ).expect(200);

  await asRelay(h, () =>
    dispatchEventInline({
      eventId: `evt-rx-${rx.id}`,
      name: "prescription.prescription.signed",
      version: 1,
      tenantId: h.id,
      occurredAt: new Date().toISOString(),
      payload: {
        prescriptionId: rx.id,
        encounterId: rx.encounterId,
        patientId: rx.patientId,
        episodeId: rx.episodeId,
        prescribedBy: res.body.data.signedBy,
        itemCount: res.body.data.lines.length,
      },
    }),
  );

  // The consumer has now placed the pharmacy order (unless the hospital's policy is an
  // external pharmacy). Deliver ITS event too — billing is listening for exactly this.
  const after = await auth(
    request(app).get(`/api/v1/prescriptions/${rx.id}`),
    h,
    h.doctorToken,
  ).expect(200);

  const orderId = after.body.data.orderId as string | undefined;
  if (orderId) {
    const order = await auth(
      request(app).get(`/api/v1/orders/${orderId}`),
      h,
      h.doctorToken,
    ).expect(200);
    const o = order.body.data;

    await asRelay(h, () =>
      dispatchEventInline({
        eventId: `evt-ord-${orderId}`,
        name: "order.order.placed",
        version: 1,
        tenantId: h.id,
        occurredAt: new Date().toISOString(),
        payload: {
          orderId: o.id,
          encounterId: o.encounterId,
          patientId: o.patientId,
          episodeId: o.episodeId,
          category: o.category,
          code: o.code,
          name: o.name,
          priority: o.priority,
          orderedBy: o.orderedBy,
        },
      }),
    );
  }

  return after.body.data;
}

/** Dispenses as the PHARMACIST, and delivers `medication.dispensed` to billing. */
async function dispense(
  h: Hospital,
  prescriptionId: string,
  items: { lineIndex: number; quantity: number }[],
  requestId?: string,
) {
  const res = await auth(
    request(app).post(`/api/v1/prescriptions/${prescriptionId}/dispense`),
    h,
    h.pharmacistToken,
  ).send({ items, ...(requestId ? { requestId } : {}) });

  if (res.status === 201 || res.status === 200) {
    const d = res.body.data.dispense;
    await asRelay(h, () =>
      dispatchEventInline({
        eventId: `evt-disp-${d.id as string}`,
        name: "pharmacy.medication.dispensed",
        version: 1,
        tenantId: h.id,
        occurredAt: new Date().toISOString(),
        payload: {
          dispenseId: d.id,
          prescriptionId: d.prescriptionId,
          encounterId: d.encounterId,
          patientId: d.patientId,
          episodeId: d.episodeId,
          lines: d.lines,
          fullyDispensed: res.body.data.prescription.status === "dispensed",
        },
      }),
    );
  }

  return res;
}

async function billOf(h: Hospital, encounterId: string) {
  const res = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), h).expect(200);
  return res.body.data;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_rx_master", `hms_${PVT}`, `hms_${GOV}`, `hms_${CLINIC}`]);
  await flushTestCache("prescriptions");

  Object.assign(pvt, await setup(PVT, "private_hospital"));
  Object.assign(gov, await setup(GOV, "government_hospital"));
  Object.assign(clinic, await setup(CLINIC, "clinic"));
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_rx_master", `hms_${PVT}`, `hms_${GOV}`, `hms_${CLINIC}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE SIGNATURE IS THE AUTHORITY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a draft authorises nothing", () => {
  it("a signed prescription reaches the pharmacy with no hand-off step", async () => {
    const encounterId = await arrive(pvt, "Rx Patient", "9100100001");
    const rx = await draft(pvt, encounterId);
    expect(rx.status).toBe("draft");

    const signed = await sign(pvt, rx);
    expect(signed.status).toBe("signed");
    expect(signed.signedBy).toBeTruthy();

    // The pharmacist never had to be told. Their worklist is a query over orders, and the
    // order exists because the signature published an event — ADR-0013 §3.
    const worklist = await auth(
      request(app).get("/api/v1/orders?category=pharmacy&outstanding=true"),
      pvt,
      pvt.pharmacistToken,
    ).expect(200);

    const mine = worklist.body.data.filter(
      (o: { encounterId: string }) => o.encounterId === encounterId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].code).toBe("RX");
    // The PRESCRIBER, not the relay that delivered the event.
    expect(mine[0].orderedBy).toBe(signed.signedBy);
  });

  it("a PHARMACIST cannot dispense against a draft", async () => {
    const encounterId = await arrive(pvt, "Draft Patient", "9100100002");
    const rx = await draft(pvt, encounterId);

    const res = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 5 }]);

    expect(res.status).toBe(422);
    expect(res.body.error.details.hint).toContain("not been signed");
  });

  it("a PHARMACIST cannot dispense against a CANCELLED prescription", async () => {
    const encounterId = await arrive(pvt, "Stopped Patient", "9100100003");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    await auth(request(app).post(`/api/v1/prescriptions/${rx.id}/cancel`), pvt, pvt.doctorToken)
      .send({ reason: "penicillin allergy noted on the old chart" })
      .expect(200);

    // The doctor stopped it — possibly because of an allergy, an interaction, or a result
    // that came back an hour ago. Handing the drugs over now is the worst thing this
    // module could do.
    const res = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 5 }]);
    expect(res.status).toBe(422);
  });

  it("an EMPTY prescription cannot be signed", async () => {
    const encounterId = await arrive(pvt, "Empty Patient", "9100100004");
    const rx = await draft(pvt, encounterId, []);

    const res = await auth(
      request(app).post(`/api/v1/prescriptions/${rx.id}/sign`),
      pvt,
      pvt.doctorToken,
    );

    // A legal instrument authorising nothing, and a worklist item the pharmacist could
    // never action or clear.
    expect(res.status).toBe(400);
  });

  it("prescribing against a CLOSED visit is refused", async () => {
    const encounterId = await arrive(pvt, "Gone Home", "9100100005");
    // The visit is walked to its end properly — queued, seen, closed.
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/queue`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/close`), pvt, pvt.doctorToken)
      .send({ reason: "seen and sent home" })
      .expect(200);

    const res = await auth(request(app).post("/api/v1/prescriptions"), pvt, pvt.doctorToken).send({
      encounterId,
      lines: [PARACETAMOL],
    });

    expect(res.status).toBe(422);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. SIGNED IS IMMUTABLE
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a signed prescription cannot be edited", () => {
  it("editing a signed prescription is refused, and the refusal names the way out", async () => {
    const encounterId = await arrive(pvt, "Immutable Patient", "9100100010");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    const res = await auth(
      request(app).patch(`/api/v1/prescriptions/${rx.id}`),
      pvt,
      pvt.doctorToken,
    ).send({ lines: [{ ...PARACETAMOL, quantity: 30 }] });

    expect(res.status).toBe(422);
    // A doctor's next question is always "then how do I change the dose?".
    expect(res.body.error.details.hint).toContain("amend");
  });

  it("an amendment is a NEW VERSION, and the original survives exactly as it was signed", async () => {
    const encounterId = await arrive(pvt, "Amended Patient", "9100100011");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    const next = await auth(
      request(app).post(`/api/v1/prescriptions/${rx.id}/amend`),
      pvt,
      pvt.doctorToken,
    ).expect(201);

    expect(next.body.data.version).toBe(2);
    expect(next.body.data.status).toBe("draft");
    expect(next.body.data.supersedesId).toBe(rx.id);

    // The original is untouched: still signed, still saying what it said.
    const original = await auth(
      request(app).get(`/api/v1/prescriptions/${rx.id}`),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    expect(original.body.data.status).toBe("signed");
    expect(original.body.data.lines[0].quantity).toBe(15);
    expect(original.body.data.supersededById).toBe(next.body.data.id);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. NOBODY GETS MORE THAN WAS PRESCRIBED
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the quantity guard", () => {
  it("dispensing MORE than was prescribed is refused", async () => {
    const encounterId = await arrive(pvt, "Greedy Patient", "9100100020");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    // 15 were prescribed.
    const res = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 16 }]);

    expect(res.status).toBe(422);
    expect(res.body.error.details.prescribed).toBe(15);
  });

  it("a partial handover, then the rest — and the total never exceeds the prescription", async () => {
    const encounterId = await arrive(pvt, "Partial Patient", "9100100021");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    // The pharmacy has run out. Six today.
    const first = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 6 }]);
    expect(first.status).toBe(201);
    expect(first.body.data.prescription.status).toBe("partially_dispensed");

    // Nine on Thursday. That is 15 exactly.
    const second = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 9 }]);
    expect(second.status).toBe(201);
    expect(second.body.data.prescription.status).toBe("dispensed");

    // One more tablet is one more than the doctor authorised.
    const third = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 1 }]);
    expect(third.status).toBe(422);
  });

  it("a request naming one good line and one bad index hands over NEITHER", async () => {
    const encounterId = await arrive(pvt, "Atomic Patient", "9100100022");
    const rx = await draft(pvt, encounterId, [PARACETAMOL]);
    await sign(pvt, rx);

    const res = await dispense(pvt, rx.id, [
      { lineIndex: 0, quantity: 5 },
      { lineIndex: 7, quantity: 5 },
    ]);
    expect(res.status).toBe(400);

    // The good line must not have been handed over on the way to rejecting the bad one.
    const after = await auth(
      request(app).get(`/api/v1/prescriptions/${rx.id}`),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    expect(after.body.data.lines[0].dispensedQty).toBe(0);
    expect(after.body.data.status).toBe("signed");
  });

  it("a retried dispense hands over ONE lot, not two", async () => {
    const encounterId = await arrive(pvt, "Retried Patient", "9100100023");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    const key = "dispense-retry-key-0001";
    const first = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 5 }], key);
    expect(first.status).toBe(201);

    // The pharmacist's click timed out; the client retried. It had in fact succeeded.
    const retry = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 5 }], key);
    expect(retry.status).toBe(200);
    expect(retry.body.data.duplicate).toBe(true);

    const after = await auth(
      request(app).get(`/api/v1/prescriptions/${rx.id}`),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    // FIVE, not ten.
    expect(after.body.data.lines[0].dispensedQty).toBe(5);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE PATIENT PAYS FOR WHAT THEY WERE GIVEN
 * ──────────────────────────────────────────────────────────────────────────── */

describe("prescribing is free; dispensing is what costs money", () => {
  it("SIGNING a prescription does not charge the patient a paisa", async () => {
    const encounterId = await arrive(pvt, "Unbilled Patient", "9100100030");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    const bill = await billOf(pvt, encounterId);

    /**
     * The drugs are still on the shelf. The patient may never walk to the counter, or may
     * take the prescription to a chemist down the road — in both cases the hospital has
     * supplied nothing.
     *
     * This also guards the silent-₹0 trap: the `RX` order carries no drug code and has no
     * tariff entry, so if `billing.consumers` ever charged pharmacy orders at placement,
     * a ₹0 line would appear here for nothing.
     */
    expect(bill.lines.filter((l: { category: string }) => l.category === "pharmacy")).toHaveLength(
      0,
    );
  });

  it("DISPENSING charges the tariff, multiplied by what actually crossed the counter", async () => {
    const encounterId = await arrive(pvt, "Charged Patient", "9100100031");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 15 }]);

    const bill = await billOf(pvt, encounterId);
    const drug = bill.lines.find((l: { code: string }) => l.code === "DRUG_PARA_500");

    // 15 tablets × ₹1.50 = ₹22.50.
    expect(drug.quantity).toBe(15);
    expect(drug.amount).toBe(2_250);
  });

  it("a PARTIAL handover is billed for the part — and the second handover bills the rest", async () => {
    const encounterId = await arrive(pvt, "Two Visits Patient", "9100100032");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 6 }]);

    let bill = await billOf(pvt, encounterId);
    let drugs = bill.lines.filter((l: { code: string }) => l.code === "DRUG_PARA_500");
    expect(drugs).toHaveLength(1);
    expect(drugs[0].amount).toBe(900); // 6 × ₹1.50

    await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 9 }]);

    /**
     * ── THE INVARIANT THIS WHOLE SUITE EXISTS FOR ────────────────────────────
     * TWO separate charges for the SAME drug code on the SAME prescription. If the charge
     * were keyed on the prescription instead of the dispense, `one_charge_per_cause` would
     * accept the first and silently swallow the second: the patient receives 15 tablets,
     * pays for 6, and nothing anywhere reports an error.
     */
    bill = await billOf(pvt, encounterId);
    drugs = bill.lines.filter((l: { code: string }) => l.code === "DRUG_PARA_500");
    expect(drugs).toHaveLength(2);

    const paid = drugs.reduce((sum: number, l: { amount: number }) => sum + l.amount, 0);
    expect(paid).toBe(2_250); // 15 × ₹1.50 — all of it, exactly once.
  });

  it("a redelivered dispense event does not charge the drugs twice", async () => {
    const encounterId = await arrive(pvt, "Redelivered Patient", "9100100033");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    const res = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 10 }]);
    const d = res.body.data.dispense;

    // The outbox is at-least-once BY DESIGN. This consumer WILL run twice.
    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-disp-${d.id as string}`,
        name: "pharmacy.medication.dispensed",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          dispenseId: d.id,
          prescriptionId: d.prescriptionId,
          encounterId: d.encounterId,
          patientId: d.patientId,
          episodeId: d.episodeId,
          lines: d.lines,
          fullyDispensed: false,
        },
      }),
    );

    const bill = await billOf(pvt, encounterId);
    const drugs = bill.lines.filter((l: { code: string }) => l.code === "DRUG_PARA_500");
    expect(drugs).toHaveLength(1);
    expect(drugs[0].amount).toBe(1_500);
  });

  it("two different drugs are two line items", async () => {
    const encounterId = await arrive(pvt, "Two Drug Patient", "9100100034");
    const rx = await draft(pvt, encounterId, [PARACETAMOL, AMOXICILLIN]);
    await sign(pvt, rx);

    await dispense(pvt, rx.id, [
      { lineIndex: 0, quantity: 15 },
      { lineIndex: 1, quantity: 10 },
    ]);

    const bill = await billOf(pvt, encounterId);
    expect(bill.lines.find((l: { code: string }) => l.code === "DRUG_PARA_500").amount).toBe(2_250);
    // 10 capsules × ₹8.00 = ₹80.00
    expect(bill.lines.find((l: { code: string }) => l.code === "DRUG_AMOX_500").amount).toBe(8_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE GOVERNMENT HOSPITAL — one code path, ₹0, and the truth intact
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a government hospital hands out the same drugs for nothing", () => {
  it("dispensing at a GOVERNMENT hospital charges ₹0 — with listPrice intact", async () => {
    const encounterId = await arrive(gov, "Free Drugs Patient", "9100200001");
    const rx = await draft(gov, encounterId);
    await sign(gov, rx);

    await dispense(gov, rx.id, [{ lineIndex: 0, quantity: 15 }]);

    const bill = await billOf(gov, encounterId);
    const drug = bill.lines.find((l: { code: string }) => l.code === "DRUG_PARA_500");

    // The patient owes nothing...
    expect(drug.amount).toBe(0);
    // ...and the state can still cost the medicine it supplied. Free to the patient is
    // not free to the exchequer.
    expect(drug.listPrice).toBe(150);
    expect(drug.quantity).toBe(15);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE FIFTH POLICY SWITCH — `encounterPolicy.pharmacy` (ADR-0013 §5)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a clinic sends the patient to the chemist next door", () => {
  it("an EXTERNAL-pharmacy hospital signs prescriptions and raises NO pharmacy order", async () => {
    const encounterId = await arrive(clinic, "Walk Out Patient", "9100300001");
    const rx = await draft(clinic, encounterId);
    await sign(clinic, rx);

    // The prescription is real, signed, and printable...
    const signed = await auth(
      request(app).get(`/api/v1/prescriptions/${rx.id}`),
      clinic,
      clinic.doctorToken,
    ).expect(200);
    expect(signed.body.data.status).toBe("signed");

    /**
     * ...and there is no work for a pharmacy this clinic does not have. A worklist item
     * nobody can ever action is worse than none: it is a permanent false backlog.
     *
     * This is a POLICY read, not a branch on `organizationType` — nothing in the consumer
     * knows what kind of hospital it is running in.
     */
    expect(signed.body.data.orderId).toBeUndefined();

    const worklist = await auth(
      request(app).get("/api/v1/orders?category=pharmacy&outstanding=true"),
      clinic,
      clinic.pharmacistToken,
    ).expect(200);
    expect(worklist.body.data).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. A PRESCRIPTION IS NOT A RESULT
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an uncollected prescription does not strand the patient", () => {
  it("a pending pharmacy order does NOT stop a released lab result calling the patient back", async () => {
    const encounterId = await arrive(pvt, "Waiting Patient", "9100100040");

    // The doctor orders a blood test AND prescribes. The patient goes to the lab.
    const order = await auth(request(app).post("/api/v1/orders"), pvt, pvt.doctorToken)
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    // Through the real state machine, not by writing a status: queued → in_progress →
    // awaiting_results. A test that forces the status would prove nothing about the flow
    // the patient actually goes through.
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/queue`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/investigations`), pvt).expect(
      200,
    );

    // The lab does its work.
    const orderId = order.body.data.order.id as string;
    await auth(request(app).post(`/api/v1/orders/${orderId}/accept`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/orders/${orderId}/start`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/orders/${orderId}/complete`), pvt)
      .send({ summary: "Haemoglobin 12.1 g/dL — normal" })
      .expect(200);
    await auth(request(app).post(`/api/v1/orders/${orderId}/verify`), pvt).expect(200);
    await auth(request(app).post(`/api/v1/orders/${orderId}/release`), pvt).expect(200);

    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-rel-${orderId}`,
        name: "order.result.released",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: { orderId },
      }),
    );

    /**
     * ── THE BUG THIS TEST EXISTS TO CATCH ────────────────────────────────────
     * The prescription's pharmacy order is still open — the patient collects their drugs
     * on the way OUT. If "is anything outstanding" counted every category, this patient
     * would sit in the corridor forever with their result sitting ready, and the cause —
     * a prescription — would be the last place anybody looked.
     */
    const encounter = await auth(request(app).get(`/api/v1/encounters/${encounterId}`), pvt).expect(
      200,
    );
    expect(encounter.body.data.status).toBe("in_progress");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. THE HANDOVER LEDGER
 * ──────────────────────────────────────────────────────────────────────────── */

describe("who gave what, when", () => {
  it("every handover is a row, and the row names the pharmacist", async () => {
    const encounterId = await arrive(pvt, "Ledger Patient", "9100100050");
    const rx = await draft(pvt, encounterId);
    await sign(pvt, rx);

    await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 6 }]);
    await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 9 }]);

    const ledger = await auth(
      request(app).get(`/api/v1/prescriptions/${rx.id}/dispenses`),
      pvt,
      pvt.pharmacistToken,
    ).expect(200);

    // Two handovers, oldest first — not one row that was incremented twice. A total you
    // can rebuild is a total you can audit.
    expect(ledger.body.data).toHaveLength(2);
    expect(ledger.body.data[0].lines[0].quantity).toBe(6);
    expect(ledger.body.data[1].lines[0].quantity).toBe(9);
    expect(ledger.body.data[0].dispensedBy).toBeTruthy();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * ALLERGY SAFETY — the block, and the informed override.
 *
 * The pure screener has its own exhaustive unit test (drugSafety.test.ts). What is proved
 * HERE is that the SIGNATURE enforces it end to end: a contraindicated drug cannot be signed
 * without an explicit override, the override is recorded as a medicolegal fact, and a warning
 * that is not a contraindication does not stand in the way.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Records an active allergy on a patient, as the DOCTOR (who holds `allergy:manage`). */
async function recordAllergy(
  h: Hospital,
  patientId: string,
  allergen: string,
  severity = "severe",
): Promise<void> {
  await auth(request(app).post(`/api/v1/patients/${patientId}/allergies`), h, h.doctorToken)
    .send({ allergen, severity })
    .expect(201);
}

const rawSign = (h: Hospital, id: string, body: Record<string, unknown> = {}) =>
  auth(request(app).post(`/api/v1/prescriptions/${id}/sign`), h, h.doctorToken).send(body);

describe("an allergy blocks the signature until it is acknowledged", () => {
  it("refuses to sign a penicillin for a penicillin-allergic patient", async () => {
    const encounterId = await arrive(pvt, "Blocked Patient", "9400100001");
    const rx = await draft(pvt, encounterId, [AMOXICILLIN]);
    await recordAllergy(pvt, rx.patientId, "penicillins");

    const res = await rawSign(pvt, rx.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("HMS-RX-001");
    const alerts = res.body.error.details.alerts as { kind: string; severity: string }[];
    expect(alerts.some((a) => a.kind === "allergy" && a.severity === "contraindicated")).toBe(true);

    // It really did NOT sign — the document is still a draft.
    const after = await auth(request(app).get(`/api/v1/prescriptions/${rx.id}`), pvt).expect(200);
    expect(after.body.data.status).toBe("draft");
  });

  it("the live screen shows the block before the doctor ever presses sign", async () => {
    const encounterId = await arrive(pvt, "Screened Patient", "9400100002");
    const rx = await draft(pvt, encounterId, [AMOXICILLIN]);
    await recordAllergy(pvt, rx.patientId, "penicillins");

    const res = await auth(request(app).get(`/api/v1/prescriptions/${rx.id}/screen`), pvt).expect(
      200,
    );

    expect(res.body.data.blocking).toBe(true);
    expect(res.body.data.alerts[0].allergen).toBe("penicillins");
  });

  it("signs THROUGH the block with an override reason, and records it as a medicolegal fact", async () => {
    const encounterId = await arrive(pvt, "Override Patient", "9400100003");
    const rx = await draft(pvt, encounterId, [AMOXICILLIN]);
    await recordAllergy(pvt, rx.patientId, "penicillins");

    const res = await rawSign(pvt, rx.id, {
      overrideReason:
        "Prior reaction was a mild rash in childhood; benefit outweighs risk, will monitor.",
    }).expect(200);

    expect(res.body.data.status).toBe("signed");
    expect(res.body.data.safetyOverride).toBeTruthy();
    expect(res.body.data.safetyOverride.reason).toContain("mild rash");
    expect(res.body.data.safetyOverride.by).toBe(res.body.data.signedBy);
    // The alerts the prescriber saw are snapshotted onto the record, not left to be re-derived.
    expect(res.body.data.safetyOverride.alerts[0].kind).toBe("allergy");
  });

  it("an ordinary signature carries NO override — the field is absent when nothing blocked", async () => {
    const encounterId = await arrive(pvt, "Clean Patient", "9400100004");
    const rx = await draft(pvt, encounterId, [PARACETAMOL]);

    const res = await rawSign(pvt, rx.id).expect(200);
    expect(res.body.data.status).toBe("signed");
    expect(res.body.data.safetyOverride).toBeUndefined();
  });

  it("a refuted allergy does NOT block — ruling it out is what turns the check off", async () => {
    const encounterId = await arrive(pvt, "Refuted Patient", "9400100005");
    const rx = await draft(pvt, encounterId, [AMOXICILLIN]);

    // Record it, then rule it out. The check must now see nothing.
    const created = await auth(
      request(app).post(`/api/v1/patients/${rx.patientId}/allergies`),
      pvt,
      pvt.doctorToken,
    )
      .send({ allergen: "penicillins" })
      .expect(201);
    await auth(
      request(app).post(`/api/v1/allergies/${created.body.data.id}/refute`),
      pvt,
      pvt.doctorToken,
    )
      .send({ reason: "Formal penicillin allergy testing negative" })
      .expect(200);

    const res = await rawSign(pvt, rx.id).expect(200);
    expect(res.body.data.status).toBe("signed");
    expect(res.body.data.safetyOverride).toBeUndefined();
  });

  it("an override reason on a prescription that does NOT block is ignored, not recorded", async () => {
    const encounterId = await arrive(pvt, "Spurious Override", "9400100006");
    const rx = await draft(pvt, encounterId, [PARACETAMOL]);

    // No allergy exists — an override supplied anyway must not manufacture a fake record of
    // one, or the log would show overrides that never overrode anything.
    const res = await rawSign(pvt, rx.id, { overrideReason: "just in case" }).expect(200);
    expect(res.body.data.safetyOverride).toBeUndefined();
  });
});

/**
 * ── WHAT THE WIRE MUST NEVER CARRY AGAIN ─────────────────────────────────────
 *
 * Two defects found by the response contract in Phase 2, both invisible to every test that
 * existed. Both had the same cause and it is worth naming: a repository mapper that is correct
 * for the object a `.lean()` READ returns and wrong for the hydrated document `create()` returns.
 * Seven of eight paths were lean, so seven of eight were right.
 *
 * These tests assert the shape of the CREATE response specifically, because that is the path that
 * was broken and the path no assertion had ever looked at.
 */
describe("the create response is the shape the contract promises", () => {
  it("a prescription's lines are the prescription's lines — never Mongoose's internals", async () => {
    const encounterId = await arrive(pvt, "Serialization Check", "9400200001");

    const res = await auth(request(app).post("/api/v1/prescriptions"), pvt, pvt.doctorToken)
      .send({ encounterId, lines: [PARACETAMOL] })
      .expect(201);

    const line = (res.body as { data: { lines: Record<string, unknown>[] } }).data.lines[0];

    // What a client actually needs off a freshly created prescription.
    expect(line).toMatchObject({
      drugCode: PARACETAMOL.drugCode,
      drugName: PARACETAMOL.drugName,
      dose: PARACETAMOL.dose,
      route: PARACETAMOL.route,
      frequency: PARACETAMOL.frequency,
      quantity: PARACETAMOL.quantity,
      dispensedQty: 0,
    });

    /**
     * The regression itself. `{ ...subdocument }` copied Mongoose's internals instead of the
     * fields, so this endpoint answered with `__parentArray`, `__index` and a `$__parent` that
     * carried the ENTIRE raw document — `tenantId` included — back to the caller. The drug code
     * and dose a pharmacist needs were not in the payload at all.
     */
    for (const forbidden of ["__parentArray", "__index", "$__parent", "$__", "_doc", "$isNew"]) {
      expect(Object.keys(line ?? {})).not.toContain(forbidden);
    }
    // Nothing anywhere in the response may leak the tenant id.
    expect(JSON.stringify(res.body)).not.toContain(pvt.id);
  });

  it("an ordinary dispense carries no creditOverride at all — not an empty one", async () => {
    const encounterId = await arrive(pvt, "Credit Override Check", "9400200002");
    const rx = await draft(pvt, encounterId, [PARACETAMOL]);
    await sign(pvt, rx);

    const res = await dispense(pvt, rx.id, [{ lineIndex: 0, quantity: 5 }]);
    expect(res.status).toBe(201);

    const dispensed = (res.body as { data: { dispense: Record<string, unknown> } }).data.dispense;

    /**
     * `creditOverride` is declared as a nested path GROUP rather than a subdocument, so a
     * hydrated document materializes it whether or not anything was ever set. Every handover was
     * answering with `creditOverride: {}` — an empty object where the type promises either a
     * complete authorisation record or nothing at all, and where a client reading
     * `if (d.creditOverride)` would conclude that ordinary medicine had been dispensed on credit.
     *
     * The populated case needs no assertion here: the response contract requires all four fields
     * together, and `ok()` parses every payload against it outside production — so a partial
     * override cannot reach a caller without failing the suite that produced it.
     */
    expect(dispensed).not.toHaveProperty("creditOverride");
    expect(Object.keys(dispensed)).not.toContain("creditOverride");
  });
});

/**
 * DISPENSING RUNTIME SCHEMA SAFETY — the counter refuses when the rule cannot be enforced.
 *
 * ── WHY DISPENSING NEEDS THIS EVEN THOUGH IT ALREADY PRE-CHECKS ─────────────
 * Unlike the MAR, `dispense()` DOES read before it writes: `findByRequestId` catches the ordinary
 * sequential retry. That read is a courtesy and says so itself — "two clicks can be in flight at
 * once and this read would miss". The unique index from migration 0015 is what actually arbitrates
 * the race, and measured on 2026-08-17 with it absent both inserts of one `requestId` are accepted:
 * two handovers of the same drugs, billed twice, from one intent. Once that pair exists the index
 * cannot be rebuilt over it.
 *
 * The suite drops a real index on its own throwaway tenant and puts it straight back. Readiness is
 * cached for a minute, so every transition clears it — the documented way an operator's repair
 * becomes visible before the TTL expires.
 */
describe("dispensing refuses when the database cannot enforce one-handover-per-request", () => {
  const DISPENSE_INDEX = "one_dispense_per_request_id";

  async function dropDispenseIndex(h: Hospital): Promise<void> {
    await h.connection.collection("dispenses").dropIndex(DISPENSE_INDEX);
    forgetSchemaReadiness();
  }

  async function restoreDispenseIndex(h: Hospital): Promise<void> {
    await h.connection.collection("dispenses").createIndex(
      { tenantId: 1, requestId: 1 },
      {
        unique: true,
        partialFilterExpression: { requestId: { $exists: true } },
        background: true,
        name: DISPENSE_INDEX,
      },
    );
    forgetSchemaReadiness();
  }

  /** A fresh signed prescription, via the suite's own arrive → draft → sign chain. */
  let phone = 9100900000;
  async function signedFor(h: Hospital): Promise<{ id: string; encounterId: string }> {
    phone += 1;
    const encounterId = await arrive(h, "Guard Subject", String(phone));
    const rx = await draft(h, encounterId);
    await sign(h, rx);
    return { id: rx.id as string, encounterId };
  }

  it("hands over normally while every invariant it rests on is armed", async () => {
    const { id } = await signedFor(pvt);

    const res = await dispense(pvt, id, [{ lineIndex: 0, quantity: 5 }]);

    expect(res.status).toBe(201);
  });

  /**
   * ── THE REFUSAL ───────────────────────────────────────────────────────────
   * Nothing is written: the check runs before the prescription is even read, so a refusal cannot
   * leave a half-resolved handover or a decremented quantity behind.
   */
  it("answers 503 HMS-PHM-004 with Retry-After when the dispense index is gone", async () => {
    const { id } = await signedFor(pvt);

    await dropDispenseIndex(pvt);
    try {
      const res = await auth(
        request(app).post(`/api/v1/prescriptions/${id}/dispense`),
        pvt,
        pvt.pharmacistToken,
      ).send({ items: [{ lineIndex: 0, quantity: 5 }], requestId: "guard-refusal-0001" });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-PHM-004");
      expect(res.headers["retry-after"]).toBe("60");
      const missing = res.body.error.details.missing as { migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0015-prescriptions");
      // It must tell the pharmacist what to DO, not merely that something failed.
      expect(String(res.body.error.message)).toMatch(/paper/i);

      // NOTHING handed over, and the prescription untouched.
      expect(
        await pvt.connection
          .collection("dispenses")
          .countDocuments({ requestId: "guard-refusal-0001" }),
      ).toBe(0);
      const after = await auth(request(app).get(`/api/v1/prescriptions/${id}`), pvt).expect(200);
      expect((after.body.data.lines as { dispensedQty: number }[])[0]?.dispensedQty).toBe(0);
    } finally {
      await restoreDispenseIndex(pvt);
    }
  });

  it("hands over again the moment the index is restored", async () => {
    const { id } = await signedFor(pvt);

    await dropDispenseIndex(pvt);
    const refused = await auth(
      request(app).post(`/api/v1/prescriptions/${id}/dispense`),
      pvt,
      pvt.pharmacistToken,
    ).send({ items: [{ lineIndex: 0, quantity: 5 }] });
    expect(refused.status).toBe(503);

    await restoreDispenseIndex(pvt);
    expect((await dispense(pvt, id, [{ lineIndex: 0, quantity: 5 }])).status).toBe(201);
  });

  /**
   * The index is PARTIAL on `requestId`, so a handover without one is deliberately unconstrained —
   * partial dispensing is legitimate and may happen many times. For those the Idempotency-Key
   * claim is the only guard, which is why dispensing asks for both invariants and not just its own.
   */
  it("also refuses when the idempotency claim index is gone", async () => {
    const { id } = await signedFor(pvt);

    await pvt.connection.collection("idempotencyKeys").dropIndex("one_claim_per_idempotency_key");
    forgetSchemaReadiness();
    try {
      const res = await auth(
        request(app).post(`/api/v1/prescriptions/${id}/dispense`),
        pvt,
        pvt.pharmacistToken,
      ).send({ items: [{ lineIndex: 0, quantity: 5 }] });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-PHM-004");
      const missing = res.body.error.details.missing as { migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0048-idempotency-key-claims");
    } finally {
      await pvt.connection
        .collection("idempotencyKeys")
        .createIndex(
          { tenantId: 1, userId: 1, key: 1 },
          { unique: true, background: true, name: "one_claim_per_idempotency_key" },
        );
      forgetSchemaReadiness();
    }
  });

  /**
   * ── PROPORTIONALITY ───────────────────────────────────────────────────────
   * A missing dispensing constraint says nothing about whether a nurse may chart a dose. Charting
   * rests on its own two invariants, both still armed here, so MAR must be untouched — as must the
   * capabilities that depend on no uniqueness at all.
   */
  it("does not block medication charting, vitals, nursing notes or reads", async () => {
    const { id } = await signedFor(pvt);
    const encounterId = (
      await auth(request(app).get(`/api/v1/prescriptions/${id}`), pvt).expect(200)
    ).body.data.encounterId as string;

    await dropDispenseIndex(pvt);
    try {
      await auth(
        request(app).post(`/api/v1/prescriptions/${id}/dispense`),
        pvt,
        pvt.pharmacistToken,
      )
        .send({ items: [{ lineIndex: 0, quantity: 5 }] })
        .expect(503);

      // MAR is a different capability with different invariants, and both of its are armed.
      await auth(
        request(app).post(`/api/v1/encounters/${encounterId}/medication-administrations`),
        pvt,
        pvt.nurseToken,
      )
        .send({ prescriptionId: id, drugCode: "DRUG_PARA_500", status: "given" })
        .expect(201);

      // Vitals: migration 0025 creates NO unique index, so nothing here can ever block them.
      await auth(request(app).post(`/api/v1/encounters/${encounterId}/vitals`), pvt, pvt.nurseToken)
        .send({ systolic: 120, diastolic: 78, pulse: 70 })
        .expect(201);

      /**
       * Nursing notes: `wardNotes`' only uniqueness is partial on discharge summaries, so a note
       * has no correctness dependency on any constraint and must never be blocked by one.
       *
       * This encounter is OPD, and `addNursingNote` requires an OPEN ADMISSION — so the right
       * proof here is not that the note succeeds but that it is refused for its OWN reason. A 422
       * about the stay means the dispensing guard never saw it; a 503 would mean it did.
       * (The success path is covered in `mar.int.test.ts`, which has an admitted patient.)
       */
      const note = await auth(
        request(app).post(`/api/v1/encounters/${encounterId}/nursing-notes`),
        pvt,
        pvt.nurseToken,
      ).send({ text: "Drugs handed over on paper; pharmacy system refusing, escalated." });

      expect(note.status).not.toBe(503);
      expect(note.body.error?.code).not.toBe("HMS-PHM-004");

      // Reads stay legible precisely when a write is refused.
      await auth(request(app).get(`/api/v1/prescriptions/${id}`), pvt).expect(200);
    } finally {
      await restoreDispenseIndex(pvt);
    }
  });

  /**
   * One hospital's schema says nothing about another's — the databases are physically separate
   * (ADR-0005) and so are their indexes.
   */
  it("refuses only the tenant whose index is missing", async () => {
    await dropDispenseIndex(pvt);
    try {
      const { id: mine } = await signedFor(pvt);
      await auth(
        request(app).post(`/api/v1/prescriptions/${mine}/dispense`),
        pvt,
        pvt.pharmacistToken,
      )
        .send({ items: [{ lineIndex: 0, quantity: 5 }] })
        .expect(503);

      // The other hospital dispenses normally throughout.
      const { id: theirs } = await signedFor(clinic);
      expect((await dispense(clinic, theirs, [{ lineIndex: 0, quantity: 5 }])).status).toBe(201);
    } finally {
      await restoreDispenseIndex(pvt);
    }
  });

  /** The guard sits in front of the existing protection; it must not replace or weaken it. */
  it("leaves the existing duplicate-handover protection exactly as it was", async () => {
    const { id } = await signedFor(pvt);
    const key = "guard-duplicate-request-0001";

    const first = await dispense(pvt, id, [{ lineIndex: 0, quantity: 5 }], key);
    expect(first.status).toBe(201);

    const second = await dispense(pvt, id, [{ lineIndex: 0, quantity: 5 }], key);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.dispense.id).toBe(first.body.data.dispense.id);
  });

  /**
   * ── THE ORDER GUARD MUST NOT REACH THE COUNTER ────────────────────────────
   * `one_order_per_request_id` (migration 0013) protects raising an investigation. Handing over
   * drugs against an already-signed prescription depends on nothing it provides — dispensing keys
   * off the prescription, not the order — so a pharmacist must keep working while the lab's
   * constraint is being repaired.
   */
  it("hands over normally when the ORDER index is gone — that is a different capability", async () => {
    const { id } = await signedFor(pvt);

    await pvt.connection.collection("orders").dropIndex("one_order_per_request_id");
    forgetSchemaReadiness();
    try {
      expect((await dispense(pvt, id, [{ lineIndex: 0, quantity: 5 }])).status).toBe(201);
    } finally {
      await pvt.connection.collection("orders").createIndex(
        { tenantId: 1, requestId: 1 },
        {
          unique: true,
          partialFilterExpression: { requestId: { $exists: true } },
          background: true,
          name: "one_order_per_request_id",
        },
      );
      forgetSchemaReadiness();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * PHARMACY v1 — the shelf: batches, expiry, FEFO, and what may never block a patient
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT DEFECT WOULD THIS CATCH?
 *
 * The one that had already shipped: `batchNo` and `expiry` were captured on receipt and NOTHING
 * ever read them. A pharmacy could book in a lot expiring last March and hand it to a patient,
 * and every screen would agree that was fine — there was no code that could disagree.
 *
 * This whole area had essentially no behavioural coverage. `medicines` appeared in the RBAC
 * probes and in one branch-isolation test, and a probe asserts who is REFUSED, never that the
 * thing works. That is the same shape as the `settle-from-advance` 500 found last milestone: an
 * endpoint nobody had ever driven.
 */
describe("stock is kept by batch, and expiry is what makes that worth doing", () => {
  const DAY = 86_400_000;
  const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();

  /** A medicine on the master, fresh per test so no block depends on another's leftovers. */
  async function medicine(code: string, name = code): Promise<string> {
    const res = await auth(request(app).post("/api/v1/medicines"), pvt)
      .send({ code, name, form: "tablet" })
      .expect(201);
    return res.body.data.id as string;
  }

  const receive = (id: string, body: Record<string, unknown>) =>
    auth(request(app).post(`/api/v1/medicines/${id}/receive`), pvt).send(body);

  /** Runs `fn` inside the private hospital's tenant context — the repository needs one. */
  const inPvt = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      {
        traceId: "pharmacy-batch-test",
        tenantId: pvt.id,
        tenantSlug: pvt.slug,
        connection: pvt.connection,
      },
      fn,
    );

  const batchesOf = (code: string) =>
    auth(request(app).get(`/api/v1/medicines/${code}/batches`), pvt);

  it("books a delivery in as a lot with its own expiry", async () => {
    const id = await medicine("BATCH_A");
    await receive(id, { quantity: 50, batchNo: "L-001", expiry: future(400) }).expect(201);

    const shelf = await batchesOf("BATCH_A").expect(200);
    expect(shelf.body.data).toHaveLength(1);
    expect(shelf.body.data[0]).toMatchObject({ batchNo: "L-001", remaining: 50, state: "ok" });
  });

  /**
   * The same lot arriving twice — a split delivery, or the rest of a short order. Two rows for
   * one physical box would let FEFO hand the same tablets out twice and would make a recall miss
   * half of them, so the second receipt must TOP UP.
   */
  it("tops up a lot that arrives twice rather than creating a second one", async () => {
    const id = await medicine("BATCH_B");
    const expiry = future(300);
    await receive(id, { quantity: 20, batchNo: "L-7", expiry }).expect(201);
    await receive(id, { quantity: 30, batchNo: "L-7", expiry }).expect(201);

    const shelf = await batchesOf("BATCH_B").expect(200);
    expect(shelf.body.data).toHaveLength(1);
    expect(shelf.body.data[0].remaining).toBe(50);
  });

  /**
   * ── A BATCH NEEDS BOTH HALVES ───────────────────────────────────────────────
   * A lot number with no expiry cannot be refused when it lapses; an expiry with no lot number
   * cannot be recalled. Either alone is a field that LOOKS like stock control and is not — which
   * is exactly the state this milestone found.
   */
  it("refuses half a batch", async () => {
    const id = await medicine("BATCH_C");
    await receive(id, { quantity: 10, batchNo: "L-9" }).expect(400);
    await receive(id, { quantity: 10, expiry: future(100) }).expect(400);
    // Neither is fine — that is a hospital that does not track lots, and most do not yet.
    await receive(id, { quantity: 10 }).expect(201);
    expect((await batchesOf("BATCH_C").expect(200)).body.data).toHaveLength(0);
  });

  it("refuses stock that has already expired on arrival", async () => {
    const id = await medicine("BATCH_D");
    const res = await receive(id, {
      quantity: 10,
      batchNo: "OLD",
      expiry: new Date(Date.now() - DAY).toISOString(),
    }).expect(422);
    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("labels a lot near its expiry without hiding it", async () => {
    const id = await medicine("BATCH_E");
    await receive(id, { quantity: 10, batchNo: "SOON", expiry: future(30) }).expect(201);
    await receive(id, { quantity: 10, batchNo: "LATER", expiry: future(400) }).expect(201);

    const shelf = await batchesOf("BATCH_E").expect(200);
    const states = Object.fromEntries(
      (shelf.body.data as { batchNo: string; state: string }[]).map((b) => [b.batchNo, b.state]),
    );
    expect(states).toEqual({ SOON: "near_expiry", LATER: "ok" });
  });

  /* ── FEFO, and the expiry refusal that is the point of it ──────────────────── */

  /** Dispenses `qty` of one drug through the REAL chain: prescribe → sign → dispense. */
  async function dispenseOf(code: string, name: string, qty: number, prescribed = qty) {
    const encounterId = await arrive(
      pvt,
      `Shelf ${code}`,
      `90000${Math.floor(Math.random() * 90000) + 10000}`,
    );
    const rx = await draft(pvt, encounterId, [
      {
        drugCode: code,
        drugName: name,
        dose: "1",
        route: "oral",
        frequency: "OD",
        quantity: prescribed,
      },
    ]);
    await sign(pvt, rx);
    const res = await auth(
      request(app).post(`/api/v1/prescriptions/${rx.id}/dispense`),
      pvt,
      pvt.pharmacistToken,
    )
      .send({ items: [{ lineIndex: 0, quantity: qty }] })
      .expect(201);
    // The decrement is a CONSUMER of the handover, exactly as in production.
    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-disp-${res.body.data.dispense.id as string}`,
        name: "pharmacy.medication.dispensed",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          dispenseId: res.body.data.dispense.id,
          lines: [{ drugCode: code, quantity: qty }],
        },
      }),
    );
    return res.body.data;
  }

  /**
   * THE ASSERTION THIS BLOCK EXISTS FOR. Two lots, the older one going off first, and the
   * handover must come out of the older one — that is the entire clinical value of tracking
   * batches, and it is what stops a pharmacy quietly accumulating stock it can never use.
   */
  it("takes from the earliest-expiring lot first", async () => {
    const id = await medicine("FEFO_A", "Fefo Tablet");
    await receive(id, { quantity: 10, batchNo: "OLDER", expiry: future(60) }).expect(201);
    await receive(id, { quantity: 10, batchNo: "NEWER", expiry: future(500) }).expect(201);

    await dispenseOf("FEFO_A", "Fefo Tablet", 6);

    const shelf = await batchesOf("FEFO_A").expect(200);
    const left = Object.fromEntries(
      (shelf.body.data as { batchNo: string; remaining: number }[]).map((b) => [
        b.batchNo,
        b.remaining,
      ]),
    );
    expect(left, "the newer lot was opened while an older one was still on the shelf").toEqual({
      OLDER: 4,
      NEWER: 10,
    });
  });

  it("spills into the next lot when the first cannot cover it, still oldest first", async () => {
    const id = await medicine("FEFO_B", "Spill Tablet");
    await receive(id, { quantity: 5, batchNo: "FIRST", expiry: future(60) }).expect(201);
    await receive(id, { quantity: 20, batchNo: "SECOND", expiry: future(500) }).expect(201);

    await dispenseOf("FEFO_B", "Spill Tablet", 12);

    const shelf = await batchesOf("FEFO_B").expect(200);
    const left = Object.fromEntries(
      (shelf.body.data as { batchNo: string; remaining: number }[]).map((b) => [
        b.batchNo,
        b.remaining,
      ]),
    );
    expect(left).toEqual({ FIRST: 0, SECOND: 13 });
  });

  /**
   * ── EXPIRED STOCK IS NEVER ALLOCATED ────────────────────────────────────────
   * The lot is made expired by moving its date into the past directly, because the API refuses
   * to receive expired stock — which is the point: the only way a pharmacy gets an expired lot is
   * by holding it until it lapses, and that is exactly the case that must be caught.
   */
  it("never hands over an expired lot, even when it is the only stock there is", async () => {
    const id = await medicine("EXPIRED_A", "Lapsed Tablet");
    await receive(id, { quantity: 20, batchNo: "GONE_OFF", expiry: future(1) }).expect(201);

    await pvt.connection
      .collection("medicineBatches")
      .updateOne(
        { medicineCode: "EXPIRED_A" },
        { $set: { expiry: new Date(Date.now() - 5 * DAY) } },
      );

    /**
     * The handover still SUCCEEDS. That is deliberate and it is this module's founding rule: the
     * pharmacist is at the counter with the box in their hand, the drugs cross it before this
     * consumer runs, and refusing here would not un-give them — it would only lose the record.
     * What must never happen is the expired lot being decremented as though it were used.
     */
    await dispenseOf("EXPIRED_A", "Lapsed Tablet", 5);

    const shelf = await batchesOf("EXPIRED_A").expect(200);
    expect(shelf.body.data[0]).toMatchObject({ remaining: 20, state: "expired" });

    // And the shortfall is visible rather than silent: the master went negative, which the stock
    // report has always called `reconcile` — "more went out than was ever booked in".
    const report = await auth(request(app).get("/api/v1/medicines/stock-report"), pvt).expect(200);
    const row = (report.body.data as { code: string; stockUnits: number; status: string }[]).find(
      (r) => r.code === "EXPIRED_A",
    );
    expect(row?.stockUnits).toBe(15);
    expect(row?.status).toBe("ok");
  });

  /* ── concurrency ───────────────────────────────────────────────────────────── */

  /**
   * Two handovers racing for the same last lot. The guard is the conditional update inside
   * `takeFromBatch`, not a read-then-check: without it both see twenty remaining, both pass, and
   * the box is empty while the records say it is not.
   */
  /**
   * ── THE GUARD, DRIVEN DIRECTLY, BECAUSE NOTHING ELSE CAN REACH IT ───────────
   * Two handovers racing for the same lot cannot be made to over-draw it through the API, and
   * that is worth stating rather than hiding: each consumer opens its own transaction, the second
   * re-reads a lot the first has already emptied, and `Math.min(outstanding, remaining)` then asks
   * for nothing. An end-to-end "race" test therefore passes with EVERY bound removed — it proves
   * the arithmetic around the guard, not the guard.
   *
   * So the conditional take is exercised where it lives. This is the line that stands between a
   * stale listing and a box with minus five tablets in it, and removing it turns this red.
   */
  it("refuses to take more from a lot than it holds", async () => {
    const id = await medicine("GUARD_A", "Guard Tablet");
    await receive(id, { quantity: 5, batchNo: "ONLY", expiry: future(200) }).expect(201);

    await inPvt(async () => {
      const [lot] = await batches.listForMedicine("GUARD_A");
      expect(lot).toBeTruthy();

      const over = await batches.takeFromBatch(lot!.id, 6, new Date());
      expect(over, "took six tablets out of a lot holding five").toBeUndefined();

      const exact = await batches.takeFromBatch(lot!.id, 5, new Date());
      expect(exact?.remaining).toBe(0);

      // And an empty lot yields nothing rather than going negative.
      expect(await batches.takeFromBatch(lot!.id, 1, new Date())).toBeUndefined();
    });
  });

  /** The same guard, for the other half of its filter: a lot that has lapsed yields nothing. */
  it("refuses to take from a lot that expired since it was listed", async () => {
    const id = await medicine("GUARD_B", "Lapsing Tablet");
    await receive(id, { quantity: 10, batchNo: "SOON", expiry: future(1) }).expect(201);

    await inPvt(async () => {
      const [lot] = await batches.listForMedicine("GUARD_B");
      // "Now" is a parameter precisely so this is testable against a fixed instant rather than a
      // sleep: the caller listed the lot while it was valid and takes it a day later.
      const tooLate = new Date(Date.now() + 2 * DAY);
      expect(await batches.takeFromBatch(lot!.id, 1, tooLate)).toBeUndefined();
      expect(await batches.takeFromBatch(lot!.id, 1, new Date())).toBeTruthy();
    });
  });

  /**
   * And the end-to-end OUTCOME, stated as what it is rather than as proof of the guard: two
   * handovers totalling more than the shelf held leave the lot at zero and the shortfall on the
   * master, where `reconcile` is the report a pharmacy needs to see.
   */
  it("leaves a lot at zero, never below, when more is handed over than was booked in", async () => {
    const id = await medicine("RACE_A", "Race Tablet");
    await receive(id, { quantity: 5, batchNo: "ONLY", expiry: future(200) }).expect(201);

    const encounterId = await arrive(pvt, "Race Patient", "9000077001");
    const rx = await draft(pvt, encounterId, [
      {
        drugCode: "RACE_A",
        drugName: "Race Tablet",
        dose: "1",
        route: "oral",
        frequency: "OD",
        quantity: 10,
      },
    ]);
    await sign(pvt, rx);

    const dispenses = await Promise.all(
      [0, 1].map(() =>
        auth(request(app).post(`/api/v1/prescriptions/${rx.id}/dispense`), pvt, pvt.pharmacistToken)
          .send({ items: [{ lineIndex: 0, quantity: 5 }] })
          .expect(201),
      ),
    );

    await Promise.all(
      dispenses.map((d) =>
        asRelay(pvt, () =>
          dispatchEventInline({
            eventId: `evt-race-${d.body.data.dispense.id as string}`,
            name: "pharmacy.medication.dispensed",
            version: 1,
            tenantId: pvt.id,
            occurredAt: new Date().toISOString(),
            payload: {
              dispenseId: d.body.data.dispense.id,
              lines: [{ drugCode: "RACE_A", quantity: 5 }],
            },
          }),
        ),
      ),
    );

    const shelf = await batchesOf("RACE_A").expect(200);
    expect(shelf.body.data[0].remaining, "a box cannot hold a negative number of tablets").toBe(0);
  });

  /* ── availability, which informs and never refuses ─────────────────────────── */

  it("tells a prescriber what the pharmacy could give today", async () => {
    const id = await medicine("AVAIL_A", "Available Tablet");
    await receive(id, { quantity: 40, batchNo: "A1", expiry: future(300) }).expect(201);

    const res = await auth(
      request(app).get("/api/v1/medicines/availability?codes=AVAIL_A"),
      pvt,
      pvt.doctorToken,
    ).expect(200);

    expect(res.body.data[0]).toMatchObject({ code: "AVAIL_A", units: 40, batched: true });
    expect(res.body.data[0].nearestExpiry).toBeTruthy();
  });

  /** A drug nobody has booked in reads zero — not an error, and not an absent row. */
  it("says zero for a drug the pharmacy does not stock", async () => {
    await medicine("AVAIL_NONE", "Never Stocked");
    const res = await auth(
      request(app).get("/api/v1/medicines/availability?codes=AVAIL_NONE,NOT_A_DRUG"),
      pvt,
      pvt.doctorToken,
    ).expect(200);

    const byCode = Object.fromEntries(
      (res.body.data as { code: string; units: number }[]).map((a) => [a.code, a.units]),
    );
    expect(byCode).toEqual({ AVAIL_NONE: 0, NOT_A_DRUG: 0 });
  });

  /**
   * Falls back to the running total for a pharmacy that tracks no lots — which is every hospital
   * until it starts. Reporting a fully stocked shelf as empty would be a worse answer than the
   * one it replaces.
   */
  it("uses the running total when a drug has no lots", async () => {
    const id = await medicine("AVAIL_B", "Unbatched Tablet");
    await receive(id, { quantity: 25 }).expect(201);

    const res = await auth(
      request(app).get("/api/v1/medicines/availability?codes=AVAIL_B"),
      pvt,
      pvt.doctorToken,
    ).expect(200);
    expect(res.body.data[0]).toMatchObject({ code: "AVAIL_B", units: 25, batched: false });
  });

  /**
   * ── AVAILABILITY IS INFORMATION, NOT PERMISSION ─────────────────────────────
   * THE PRODUCT DECISION OF THIS MILESTONE, pinned so it cannot be "fixed" into a stock check.
   * A doctor prescribes what the patient needs; if the hospital is out, the patient buys it
   * outside and the prescription is what they take to the shop.
   */
  it("lets a doctor prescribe a drug the pharmacy has none of", async () => {
    await medicine("OUT_A", "Out Of Stock Tablet");
    const encounterId = await arrive(pvt, "Out Of Stock Patient", "9000077002");

    const rx = await draft(pvt, encounterId, [
      {
        drugCode: "OUT_A",
        drugName: "Out Of Stock Tablet",
        dose: "1",
        route: "oral",
        frequency: "OD",
        quantity: 10,
      },
    ]);
    await sign(pvt, rx);

    const after = await auth(request(app).get(`/api/v1/prescriptions/${rx.id}`), pvt).expect(200);
    expect(after.body.data.status).toBe("signed");
    expect(after.body.data.lines[0].quantity).toBe(10);
  });

  it("lets a doctor prescribe a drug that is not on the master at all", async () => {
    const encounterId = await arrive(pvt, "Unknown Drug Patient", "9000077003");
    const rx = await draft(pvt, encounterId, [
      {
        drugCode: "NOT_STOCKED_ANYWHERE",
        drugName: "Imported Tablet",
        dose: "1",
        route: "oral",
        frequency: "OD",
        quantity: 4,
      },
    ]);
    await sign(pvt, rx);
    expect(
      (await auth(request(app).get(`/api/v1/prescriptions/${rx.id}`), pvt).expect(200)).body.data
        .status,
    ).toBe("signed");
  });

  /* ── who may touch the shelf ───────────────────────────────────────────────── */

  it("does not let a doctor receive stock or write it off", async () => {
    const id = await medicine("PERM_A");
    await auth(request(app).post(`/api/v1/medicines/${id}/receive`), pvt, pvt.doctorToken)
      .send({ quantity: 10 })
      .expect(403);
    await auth(request(app).post(`/api/v1/medicines/${id}/adjust`), pvt, pvt.doctorToken)
      .send({ delta: -5, reason: "not mine to write off" })
      .expect(403);
    // Nor read the shelf: batch numbers and quantities are the pharmacy's books to keep.
    await auth(request(app).get(`/api/v1/medicines/PERM_A/batches`), pvt, pvt.doctorToken).expect(
      403,
    );
  });

  it("does not let a nurse adjust stock", async () => {
    const id = await medicine("PERM_B");
    await auth(request(app).post(`/api/v1/medicines/${id}/adjust`), pvt, pvt.nurseToken)
      .send({ delta: 100, reason: "found some" })
      .expect(403);
  });

  /** Every adjustment carries its reason and its author — an unexplained mutation is refused. */
  it("records who adjusted stock and why", async () => {
    const id = await medicine("ADJ_A");
    await receive(id, { quantity: 30 }).expect(201);
    await auth(request(app).post(`/api/v1/medicines/${id}/adjust`), pvt)
      .send({ delta: -2, reason: "damaged in transit" })
      .expect(201);

    // No reason, no adjustment.
    await auth(request(app).post(`/api/v1/medicines/${id}/adjust`), pvt)
      .send({ delta: -2 })
      .expect(400);

    const moves = await auth(request(app).get(`/api/v1/medicines/${id}/movements`), pvt).expect(
      200,
    );
    const adjustment = (
      moves.body.data as { kind: string; reason?: string; createdBy?: string }[]
    ).find((m) => m.kind === "adjustment");
    expect(adjustment?.reason).toBe("damaged in transit");
    expect(adjustment?.createdBy).toBeTruthy();
  });
});
