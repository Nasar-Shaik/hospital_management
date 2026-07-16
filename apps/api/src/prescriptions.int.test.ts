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
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { seedTariff } = await import("./seed/tariff.js");
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");

const PVT = "test-rx-pvt";
const GOV = "test-rx-gov";
const CLINIC = "test-rx-clinic";
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "rx-int-test" }));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  /** TENANT_ADMIN — used only where the act under test is not the point. */
  token: string;
  doctorToken: string;
  doctorId: string;
  pharmacistToken: string;
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
