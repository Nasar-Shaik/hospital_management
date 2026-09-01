/**
 * BILLING SUITE — release-gating (Doc 02 F-group).
 *
 * Two hospitals, one code path. That is the claim this suite exists to prove:
 *
 *   PRIVATE    — every charge posts at the tariff. The patient owes money.
 *   GOVERNMENT — every charge posts at ₹0, and the invoice is STILL REAL, with real
 *                line items carrying a real `listPrice`. Free to the patient is not
 *                free to the state, and the state has to cost the encounter.
 *
 * Nothing in the billing module reads `organizationType`. It reads `policy.billingMode`,
 * which the preset chose. If anyone ever writes the branch, `organizations.test.ts`
 * fails and names the file.
 *
 * Everything here is PAISE. 50000 is ₹500.00.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("billing");
process.env.MONGO_MASTER_DB = "test_bill_master";
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
const { setFeatureOverride, clearFeatureOverride } =
  await import("./modules/entitlements/index.js");

const PVT = "test-bill-pvt";
const GOV = "test-bill-gov";
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "billing-int-test" })));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  token: string;
  doctorId: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const pvt = {} as Hospital;
const gov = {} as Hospital;

function auth(req: request.Test, h: Hospital): request.Test {
  return req.set("Host", h.host).set("Authorization", `Bearer ${h.token}`);
}

/** Runs a consumer the way the relay does — inside a tenant-resolved context. */
async function asRelay<T>(h: Hospital, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "billing-relay-test", tenantId: h.id, tenantSlug: h.slug, connection: h.connection },
    fn,
  );
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
      await assignRoleByCode(doc.id, "DOCTOR", []);
      await transitionStatus(doc.id, "active");
      doctorId = doc.id;
    },
  );

  const host = `${slug}.medicore.test`;
  const login = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email: `admin@${slug}.test`, password: PASSWORD });

  return {
    id: t.tenant.id,
    slug,
    host,
    token: login.body.data.accessToken as string,
    doctorId,
    connection,
  };
}

/** A patient, arrived. Returns the encounter and the event the relay would deliver. */
async function arrive(h: Hospital, name: string, phone: string) {
  const p = await auth(request(app).post("/api/v1/patients"), h)
    .send({ name, gender: "female", contact: { phone } })
    .expect(201);

  const res = await auth(request(app).post("/api/v1/encounters"), h)
    .send({ patientId: p.body.data.patient.id, departmentId: h.doctorId })
    .expect(201);

  const e = res.body.data.encounter;
  return {
    encounterId: e.id as string,
    patientId: e.patientId as string,
    event: {
      eventId: `evt-enc-${e.id as string}`,
      name: "encounter.encounter.started",
      version: 1,
      tenantId: h.id,
      occurredAt: new Date().toISOString(),
      payload: { encounterId: e.id, patientId: e.patientId, episodeId: e.episodeId },
    },
  };
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_bill_master", `hms_${PVT}`, `hms_${GOV}`]);
  await flushTestCache("billing");

  Object.assign(pvt, await setup(PVT, "private_hospital"));
  Object.assign(gov, await setup(GOV, "government_hospital"));
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_bill_master", `hms_${PVT}`, `hms_${GOV}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. ONE CODE PATH, TWO HOSPITALS — the whole claim
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the same software bills a private hospital and a government hospital", () => {
  it("a PRIVATE hospital charges the tariff for arriving", async () => {
    const { encounterId, event } = await arrive(pvt, "Paying Patient", "9000100001");
    await asRelay(pvt, () => dispatchEventInline(event));

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt).expect(
      200,
    );

    // ₹500.00 — the seeded CONSULT_GEN.
    expect(bill.body.data.total).toBe(50_000);
    expect(bill.body.data.lines).toHaveLength(1);
    expect(bill.body.data.lines[0].code).toBe("CONSULT_GEN");
  });

  it("a GOVERNMENT hospital charges ₹0 — and still produces a real line item", async () => {
    const { encounterId, event } = await arrive(gov, "Free Patient", "9000100002");
    await asRelay(gov, () => dispatchEventInline(event));

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), gov).expect(
      200,
    );

    // The patient owes nothing...
    expect(bill.body.data.total).toBe(0);

    // ...and the bill is NOT empty. This is the distinction the whole design turns on:
    // `zero_tariff` is a TARIFF, not an off-switch. Skipping the charge would leave the
    // state unable to cost the encounter or report drug consumption.
    expect(bill.body.data.lines).toHaveLength(1);
    expect(bill.body.data.lines[0].code).toBe("CONSULT_GEN");
    expect(bill.body.data.lines[0].amount).toBe(0);
    // What the care was WORTH is still recorded.
    expect(bill.body.data.lines[0].listPrice).toBe(50_000);
  });

  it("a ₹0 bill finalizes straight to PAID — a govt hospital must not grow fake debtors", async () => {
    const { encounterId, event } = await arrive(gov, "Zero Bill", "9000100003");
    await asRelay(gov, () => dispatchEventInline(event));

    const res = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      gov,
    ).expect(200);

    // If this were `finalized`, every outstanding-balance report in a government
    // hospital would be a list of invoices nobody will ever pay — which makes the
    // report useless and blames the product for a problem it invented.
    expect(res.body.data.status).toBe("paid");
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.number).toMatch(/^INV-\d{4}-\d{5}$/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE DOUBLE-BILLING INVARIANT — at-least-once delivery is not an excuse
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a patient is never billed twice for one thing", () => {
  it("redelivering encounter.started does NOT post a second consultation fee", async () => {
    const { encounterId, event } = await arrive(pvt, "Redelivered", "9000100010");

    // The relay crashed after enqueueing and before marking sent. This WILL happen —
    // it is the design, not a fault. The patient must not pay twice for it.
    await asRelay(pvt, () => dispatchEventInline(event));
    await asRelay(pvt, () => dispatchEventInline(event));
    await asRelay(pvt, () => dispatchEventInline(event));

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt).expect(
      200,
    );

    expect(bill.body.data.lines).toHaveLength(1);
    expect(bill.body.data.total).toBe(50_000);
  });

  it("two deliveries RACING still post exactly one charge", async () => {
    const { encounterId, event } = await arrive(pvt, "Racing", "9000100011");

    // Two workers, one event, same instant. Only the unique index can arbitrate this —
    // a read-then-write would let both through.
    await asRelay(pvt, () =>
      Promise.allSettled([dispatchEventInline(event), dispatchEventInline(event)]),
    );

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt).expect(
      200,
    );
    expect(bill.body.data.lines).toHaveLength(1);
  });

  it("an ordered test is billed once, at the tariff", async () => {
    const { encounterId } = await arrive(pvt, "Lab Payer", "9000100012");
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);

    const order = await auth(request(app).post("/api/v1/orders"), pvt)
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    const event = {
      eventId: `evt-ord-${order.body.data.order.id as string}`,
      name: "order.order.placed",
      version: 1,
      tenantId: pvt.id,
      occurredAt: new Date().toISOString(),
      payload: {
        orderId: order.body.data.order.id,
        encounterId,
        patientId: order.body.data.order.patientId,
        episodeId: order.body.data.order.episodeId,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
      },
    };

    await asRelay(pvt, () => dispatchEventInline(event));
    await asRelay(pvt, () => dispatchEventInline(event));

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt).expect(
      200,
    );

    const cbc = (bill.body.data.lines as { code: string; amount: number }[]).filter(
      (l) => l.code === "CBC",
    );
    expect(cbc).toHaveLength(1);
    expect(cbc[0]?.amount).toBe(35_000); // ₹350.00
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. A CANCELLED TEST IS NOT BILLED
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a cancelled order stops costing money", () => {
  it("reverses the charge when the order is cancelled before the work starts", async () => {
    const { encounterId, event: arrival } = await arrive(pvt, "Cancelled Test", "9000100020");
    // The consultation fee — without this the bill below is the LFT alone, and the
    // assertion would prove nothing about the reversal.
    await asRelay(pvt, () => dispatchEventInline(arrival));
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);

    const order = await auth(request(app).post("/api/v1/orders"), pvt)
      .send({ encounterId, category: "lab", code: "LFT", name: "Liver Function" })
      .expect(201);
    const orderId = order.body.data.order.id as string;

    const placed = {
      eventId: `evt-p-${orderId}`,
      name: "order.order.placed",
      version: 1,
      tenantId: pvt.id,
      occurredAt: new Date().toISOString(),
      payload: {
        orderId,
        encounterId,
        patientId: order.body.data.order.patientId,
        episodeId: order.body.data.order.episodeId,
        category: "lab",
        code: "LFT",
        name: "Liver Function",
      },
    };
    await asRelay(pvt, () => dispatchEventInline(placed));

    let bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt);
    expect(bill.body.data.total).toBe(50_000 + 60_000);

    await auth(request(app).post(`/api/v1/orders/${orderId}/cancel`), pvt)
      .send({ reason: "patient could not wait" })
      .expect(200);

    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-c-${orderId}`,
        name: "order.order.cancelled",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: { orderId, encounterId, reason: "patient could not wait" },
      }),
    );

    // A charge that survives its cancelled order is the commonest complaint at a
    // billing counter, and it is always the software's fault.
    bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt);
    expect(bill.body.data.total).toBe(50_000);
    expect((bill.body.data.lines as { code: string }[]).some((l) => l.code === "LFT")).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. FINALIZING, AND TAKING MONEY
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the bill becomes a document", () => {
  it("finalizing freezes the lines and assigns a number; later charges do not change it", async () => {
    const { encounterId, event } = await arrive(pvt, "Frozen Bill", "9000100030");
    await asRelay(pvt, () => dispatchEventInline(event));

    const invoice = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      pvt,
    ).expect(200);

    expect(invoice.body.data.number).toMatch(/^INV-\d{4}-\d{5}$/);
    expect(invoice.body.data.total).toBe(50_000);

    // Something is charged AFTER the bill was handed over.
    await auth(request(app).post("/api/v1/charges"), pvt)
      .send({ encounterId, code: "DRESS", category: "procedure", quantity: 1 })
      .expect(201);

    // The finalized document must not move. An invoice that edits itself after it is
    // in a patient's hand is not a document, it is a suggestion.
    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt);
    expect(bill.body.data.total).toBe(50_000);
  });

  it("invoice numbers are unique under concurrency", async () => {
    // Two cashiers finalizing at the same instant must not both be handed
    // INV-2026-00042. A duplicate invoice number is a tax problem.
    const visits = await Promise.all([
      arrive(pvt, "Number One", "9000100041"),
      arrive(pvt, "Number Two", "9000100042"),
      arrive(pvt, "Number Three", "9000100043"),
    ]);
    for (const v of visits) await asRelay(pvt, () => dispatchEventInline(v.event));

    const results = await Promise.all(
      visits.map((v) =>
        auth(request(app).post(`/api/v1/encounters/${v.encounterId}/bill/finalize`), pvt),
      ),
    );

    const numbers = results.map((r) => r.body.data.number as string);
    expect(new Set(numbers).size).toBe(3);
  });

  it("refuses payment on a draft bill, and refuses to overcharge", async () => {
    const { encounterId, event } = await arrive(pvt, "Payer", "9000100050");
    await asRelay(pvt, () => dispatchEventInline(event));

    const draft = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt);
    expect(draft.body.data.invoice).toBeUndefined();

    const invoice = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      pvt,
    ).expect(200);
    const invoiceId = invoice.body.data.id as string;

    // Paying more than is owed is a data-entry slip that becomes a refund conversation.
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 100_000, method: "cash" })
      .expect(400);

    // A part payment is normal and leaves the bill open.
    const part = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 20_000, method: "upi", reference: "UPI123" })
      .expect(201);
    expect(part.body.data.status).toBe("finalized");
    expect(part.body.data.paid).toBe(20_000);

    const rest = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 30_000, method: "cash" })
      .expect(201);
    expect(rest.body.data.status).toBe("paid");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. BILLING MUST NEVER BLOCK CARE
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a missing price does not stop a patient being treated", () => {
  it("an order for a test that is not in the tariff still reaches the lab, and posts ₹0", async () => {
    const { encounterId } = await arrive(pvt, "No Tariff", "9000100060");
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);

    // A test the hospital has not priced yet. The biller's backlog must not be able to
    // stop a doctor investigating a patient.
    const order = await auth(request(app).post("/api/v1/orders"), pvt)
      .send({ encounterId, category: "lab", code: "OBSCURE_ASSAY", name: "Obscure Assay" })
      .expect(201);

    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-${order.body.data.order.id as string}`,
        name: "order.order.placed",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          orderId: order.body.data.order.id,
          encounterId,
          patientId: order.body.data.order.patientId,
          episodeId: order.body.data.order.episodeId,
          category: "lab",
          code: "OBSCURE_ASSAY",
          name: "Obscure Assay",
        },
      }),
    );

    const bill = await auth(request(app).get(`/api/v1/encounters/${encounterId}/bill`), pvt);
    const line = (bill.body.data.lines as { code: string; amount: number }[]).find(
      (l) => l.code === "OBSCURE_ASSAY",
    );

    // Posted, at 0, with a loud log — rather than throwing and failing the order.
    expect(line).toBeDefined();
    expect(line?.amount).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE MONEY ADDS UP UNDER CONCURRENCY
 *
 * `recordPayment` used to read the invoice, compute `paid + amount` in Node, and
 * `$set` that absolute back. Two payments landing together both read the same
 * `paid`, both computed the same total, and the second `$set` overwrote the first:
 * the `payments` array held BOTH entries while the scalar recorded ONE of them.
 *
 * That scalar is what every collections and dues report reads, and what the counter
 * shows the next patient. Money crossed the counter that the system did not record,
 * and the patient was asked for it again.
 *
 * These tests are the reason to believe it is fixed. Each one FAILED against the
 * previous implementation (Doc 03 §5.2; STATE_MACHINE_CATALOG §4/§5).
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the money adds up under concurrency", () => {
  /** A finalized ₹500 consultation bill, ready to take money. */
  async function finalizedBill(phone: string): Promise<string> {
    const { encounterId, event } = await arrive(pvt, "Concurrent Payer", phone);
    await asRelay(pvt, () => dispatchEventInline(event));
    const invoice = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      pvt,
    ).expect(200);
    expect(invoice.body.data.total).toBe(50_000);
    return invoice.body.data.id as string;
  }

  it("two payments landing at the same instant are BOTH recorded", async () => {
    const invoiceId = await finalizedBill("9000100060");

    // Two cashiers, two halves of one bill, at the same moment.
    const [a, b] = await Promise.all([
      auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt).send({
        amount: 25_000,
        method: "cash",
      }),
      auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt).send({
        amount: 25_000,
        method: "card",
      }),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);
    // The scalar and the ledger must agree. Under the old code `paid` was 25,000
    // while `payments` held two entries totalling 50,000.
    expect(bill.body.data.payments).toHaveLength(2);
    expect(bill.body.data.paid).toBe(50_000);
    expect(bill.body.data.status).toBe("paid");
  });

  it("the total can never exceed the bill, however many payments race", async () => {
    const invoiceId = await finalizedBill("9000100061");

    // Four quarter-payments fired at a bill that can only take two of them.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt).send({
          amount: 25_000,
          method: "cash",
        }),
      ),
    );

    const accepted = results.filter((r) => r.status === 201);
    expect(accepted).toHaveLength(2);

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);
    expect(bill.body.data.paid).toBe(50_000);
    expect(bill.body.data.payments).toHaveLength(2);
  });

  it("a retried payment takes the money ONCE and returns the original receipt", async () => {
    const invoiceId = await finalizedBill("9000100062");
    const requestId = "idem-key-double-click-0001";

    const first = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 30_000, method: "cash", requestId })
      .expect(201);
    expect(first.body.data.paid).toBe(30_000);

    // The same intent again — a double-click, or a retry after a response that never
    // arrived. It must NOT be a second ₹300.
    const replay = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 30_000, method: "cash", requestId })
      .expect(409);
    expect(replay.body.error.code).toBe("HMS-PAY-002");
    // The receipt comes back so the counter can reconcile instead of retrying again.
    expect(replay.body.error.details.receipt.amount).toBe(30_000);

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);
    expect(bill.body.data.payments).toHaveLength(1);
    expect(bill.body.data.paid).toBe(30_000);

    // A DIFFERENT key on the same bill is a genuine second part-payment, not a replay.
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 20_000, method: "upi", requestId: "idem-key-second-part-0002" })
      .expect(201);
    const settled = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt);
    expect(settled.body.data.paid).toBe(50_000);
    expect(settled.body.data.status).toBe("paid");
  });

  it("concurrent refunds cannot hand back more than was collected", async () => {
    const invoiceId = await finalizedBill("9000100063");
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), pvt)
      .send({ amount: 50_000, method: "cash" })
      .expect(201);

    // Three refunds of ₹300 against ₹500 collected: at most one can be honoured.
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        auth(request(app).post(`/api/v1/invoices/${invoiceId}/refund`), pvt).send({
          amount: 30_000,
          method: "cash",
          reason: "Cancelled service",
        }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);
    expect(bill.body.data.refunded).toBe(30_000);
    expect(bill.body.data.refunded).toBeLessThanOrEqual(bill.body.data.paid);
  });

  it("a discount computed against a stale bill is refused, not applied", async () => {
    // The version guard (Doc 03 §5.2). A discount is a judgement about a SPECIFIC bill:
    // if the bill moved after it was read, the write-down must lose rather than silently
    // restore a stale total. Asserted at the repository, because the service re-reads
    // immediately before writing and the racing window cannot be hit reliably over HTTP.
    const invoiceId = await finalizedBill("9000100064");
    const before = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);

    await asRelay(pvt, async () => {
      const repo = await import("./modules/billing/billing.repository.js");
      const live = await repo.findInvoiceById(invoiceId);
      expect(live?.version).toBeGreaterThanOrEqual(0);

      // A stale version — someone else changed the bill after we read it.
      const stale = await repo.applyDiscountGuarded(invoiceId, (live?.version ?? 0) + 99, {
        discount: 10_000,
        total: 40_000,
      });
      expect(stale).toBeUndefined();

      // The current version still applies cleanly.
      const ok = await repo.applyDiscountGuarded(invoiceId, live?.version ?? 0, {
        discount: 10_000,
        total: 40_000,
      });
      expect(ok?.total).toBe(40_000);
      // ...and the guard moved, so the same version cannot be replayed.
      expect(ok?.version).toBe((live?.version ?? 0) + 1);
    });

    expect(before.body.data.total).toBe(50_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. A RECEIPT IS A SIGNED DOCUMENT — the bill knows who took the money
 *
 * ── THE FACT WAS ALWAYS RECORDED, AND NOTHING COULD READ IT ─────────────────
 * `payments[].by` has carried the collector's user id since the first payment ever taken. The
 * printed receipt showed an anonymous "Received by ______" over it, because a user id is not a
 * name and there was no way to turn one into a name from the counter's own permission.
 *
 * That is only a cosmetic gap in a hospital with one cashier. With several across a shift it is
 * the difference between a drawer that reconciles and a dispute nobody can settle: "who took my
 * ₹500?" had no answer on the paper the patient was holding.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a bill can name the people who took the money", () => {
  let invoiceId = "";
  let cashierAId = "";
  let cashierBId = "";
  let tokenA = "";
  let tokenB = "";

  /** A 1×1 transparent PNG — a real data URI, small enough to live in a test. */
  const SIGNATURE =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  async function makeCashier(email: string, name: string, signature?: string): Promise<string> {
    let id = "";
    await runWithContext(
      {
        traceId: "cashier-setup",
        tenantId: pvt.id,
        tenantSlug: pvt.slug,
        connection: pvt.connection,
      },
      async () => {
        const user = await createUser({
          email,
          name,
          status: "invited",
          ...(signature ? { profile: { signature } } : {}),
        });
        await setPassword(user.id, PASSWORD, { mustChangePassword: false });
        await assignRoleByCode(user.id, "FRONT_OFFICE", []);
        await transitionStatus(user.id, "active");
        id = user.id;
      },
    );
    return id;
  }

  async function loginAs(email: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Host", pvt.host)
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  beforeAll(async () => {
    cashierAId = await makeCashier("priya@bill.test", "Priya Sharma", SIGNATURE);
    cashierBId = await makeCashier("ravi@bill.test", "Ravi Kumar");
    tokenA = await loginAs("priya@bill.test");
    tokenB = await loginAs("ravi@bill.test");

    const { encounterId, event } = await arrive(pvt, "Two Cashiers", "9000100090");
    await asRelay(pvt, () => dispatchEventInline(event));
    const invoice = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      pvt,
    ).expect(200);
    invoiceId = invoice.body.data.id as string;

    // The shift changes halfway through the bill — the case the whole feature exists for.
    await request(app)
      .post(`/api/v1/invoices/${invoiceId}/payments`)
      .set("Host", pvt.host)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);
    await request(app)
      .post(`/api/v1/invoices/${invoiceId}/payments`)
      .set("Host", pvt.host)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ amount: 30_000, method: "cash" })
      .expect(201);
  }, 60_000);

  it("stamps each payment with the cashier who actually took it", async () => {
    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), pvt).expect(200);
    const by = (bill.body.data.payments as { by?: string }[]).map((p) => p.by);
    expect(by).toEqual([cashierAId, cashierBId]);
  });

  it("names both of them, with the signature of the one who uploaded it", async () => {
    const res = await auth(
      request(app).get(`/api/v1/invoices/${invoiceId}/signatories`),
      pvt,
    ).expect(200);

    const byId = new Map(
      (res.body.data as { userId: string; name: string; signature?: string }[]).map((s) => [
        s.userId,
        s,
      ]),
    );
    expect(byId.get(cashierAId)?.name).toBe("Priya Sharma");
    expect(byId.get(cashierAId)?.signature).toBe(SIGNATURE);

    // The other cashier has not uploaded one. They are still NAMED — the hospital knows who took
    // the money whether or not they have got round to scanning a signature, and the receipt
    // prints a blank line rather than dropping the person.
    expect(byId.get(cashierBId)?.name).toBe("Ravi Kumar");
    expect(byId.get(cashierBId)?.signature).toBeUndefined();
  });

  /** It answers "who signed THIS bill" — it must not become a way to walk the staff directory. */
  it("returns nobody for a bill nobody has paid", async () => {
    const { encounterId, event } = await arrive(pvt, "Unpaid Nair", "9000100091");
    await asRelay(pvt, () => dispatchEventInline(event));
    const fresh = await auth(
      request(app).post(`/api/v1/encounters/${encounterId}/bill/finalize`),
      pvt,
    ).expect(200);

    const res = await auth(
      request(app).get(`/api/v1/invoices/${fresh.body.data.id as string}/signatories`),
      pvt,
    ).expect(200);
    expect(res.body.data).toEqual([]);
  });

  /**
   * The reporting half of the same fact. A hospital-wide total cannot count a drawer; this is
   * what "how much did Priya take today?" reads.
   */
  it("reports the takings per cashier, and the rows sum to the counter total", async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const res = await auth(
      request(app).get(`/api/v1/reports/collections?from=${from}&to=${to}`),
      pvt,
    ).expect(200);

    const rows = res.body.data.byCollector as {
      collectedBy: string;
      collectorName: string;
      amount: number;
    }[];
    const priya = rows.find((r) => r.collectedBy === cashierAId);
    const ravi = rows.find((r) => r.collectedBy === cashierBId);
    expect(priya?.collectorName).toBe("Priya Sharma");
    expect(priya?.amount).toBe(20_000);
    expect(ravi?.collectorName).toBe("Ravi Kumar");
    expect(ravi?.amount).toBe(30_000);

    // The breakdown must not lose money: every direct payment belongs to exactly one row.
    const summed = rows.reduce((n, r) => n + r.amount, 0);
    expect(summed).toBe(res.body.data.total);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE CASH COUNTER'S QUEUE — care given, no bill raised
 *
 * Manual testing, verbatim: "as a doctor i have ordered blood tests, in lab technician login he
 * is waiting for payment to proceed those tests. i check in admin and cashier logins to pay those
 * payments but i did not get option to pay those."
 *
 * The chain: an order posts a CHARGE, a charge has no invoice until somebody finalizes one, and
 * the cashier's screen lists INVOICES. So the money existed, was owed, and was invisible to the
 * one person whose job is to collect it — while `billing:finalize` sat in their grant with no
 * screen to use it on. These tests are the whole path a cashier now walks.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a cashier can find, bill and collect for care nobody has billed yet", () => {
  let cashierToken = "";
  let patientId = "";
  let encounterId = "";
  let episodeId = "";
  let uhid = "";

  /** A fresh ObjectId — `sourceId` is stored as one, so a made-up string is a 500. */
  const oid = (): string =>
    [...Array<number>(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");

  /** Bills a lab test exactly as the relay does when a doctor's order commits. */
  async function orderTest(
    target: { encounterId: string; patientId: string; episodeId: string },
    code: string,
  ) {
    const orderId = oid();
    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-ord-${orderId}`,
        name: "order.order.placed",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          orderId,
          encounterId: target.encounterId,
          patientId: target.patientId,
          episodeId: target.episodeId,
          code,
          name: code,
          category: "lab",
        },
      }),
    );
  }

  const pendingAs = (token: string, qs = "", branchId?: string) => {
    const req = request(app)
      .get(`/api/v1/billing/pending${qs}`)
      .set("Host", pvt.host)
      .set("Authorization", `Bearer ${token}`);
    return branchId ? req.set("X-Active-Branch", branchId) : req;
  };

  beforeAll(async () => {
    await runWithContext(
      {
        traceId: "pending-setup",
        tenantId: pvt.id,
        tenantSlug: pvt.slug,
        connection: pvt.connection,
      },
      async () => {
        const user = await createUser({
          email: "counter@bill.test",
          name: "Counter Clerk",
          status: "invited",
        });
        await setPassword(user.id, PASSWORD, { mustChangePassword: false });
        // The REAL role, not FRONT_OFFICE. A cashier deliberately holds no `encounter:read` and
        // no `encounter:create`, which is why Reception's register — the only other place a bill
        // could be raised — is not even in their navigation.
        await assignRoleByCode(user.id, "CASHIER", []);
        await transitionStatus(user.id, "active");
      },
    );
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("Host", pvt.host)
      .send({ email: "counter@bill.test", password: PASSWORD })
      .expect(200);
    cashierToken = login.body.data.accessToken as string;

    const visit = await arrive(pvt, "Lab Waiting", "9000100200");
    encounterId = visit.encounterId;
    patientId = visit.patientId;
    episodeId = visit.event.payload.episodeId as string;
    await asRelay(pvt, () => dispatchEventInline(visit.event));
    await orderTest({ encounterId, patientId, episodeId }, "CBC");
    await orderTest({ encounterId, patientId, episodeId }, "LFT");

    const p = await auth(request(app).get(`/api/v1/patients/${patientId}`), pvt).expect(200);
    uhid = p.body.data.uhid as string;
  }, 60_000);

  it("shows the visit, its total and what it is made of", async () => {
    const res = await pendingAs(cashierToken).expect(200);
    const row = (res.body.data as { encounterId: string }[]).find(
      (r) => r.encounterId === encounterId,
    );

    // ₹500 consultation + ₹350 CBC + ₹600 LFT.
    expect(row).toMatchObject({
      patientName: "Lab Waiting",
      uhid,
      amount: 50_000 + 35_000 + 60_000,
      count: 3,
    });
  });

  it("finds the patient by name and by UHID — how a counter actually works", async () => {
    const byName = await pendingAs(cashierToken, "?q=Lab%20Waiting").expect(200);
    expect(byName.body.data.map((r: { encounterId: string }) => r.encounterId)).toContain(
      encounterId,
    );

    const byUhid = await pendingAs(cashierToken, `?q=${uhid}`).expect(200);
    expect(byUhid.body.data.map((r: { encounterId: string }) => r.encounterId)).toContain(
      encounterId,
    );
  });

  it("returns NOTHING for a name that matches nobody, rather than everybody", async () => {
    /**
     * The dangerous failure. A search that quietly falls back to the unfiltered queue hands a
     * mistyped name somebody else's bill, and the cashier has no way to tell.
     */
    const res = await pendingAs(cashierToken, "?q=Nobody%20Of%20That%20Name").expect(200);
    expect(res.body.data).toEqual([]);
  });

  it("lets the cashier raise the bill and take the money, with no other role involved", async () => {
    // 1. Raise it. `billing:finalize` — the permission that previously had no screen.
    const invoice = await request(app)
      .post(`/api/v1/encounters/${encounterId}/bill/finalize`)
      .set("Host", pvt.host)
      .set("Authorization", `Bearer ${cashierToken}`)
      .expect(200);

    expect(invoice.body.data.status).toBe("finalized");
    expect(invoice.body.data.number).toBeTruthy();
    expect(invoice.body.data.total).toBe(145_000);

    // 2. Take it. `payment:collect`.
    const paid = await request(app)
      .post(`/api/v1/invoices/${invoice.body.data.id}/payments`)
      .set("Host", pvt.host)
      .set("Authorization", `Bearer ${cashierToken}`)
      .send({ amount: 145_000, method: "cash" })
      .expect(201);

    expect(paid.body.data.status).toBe("paid");
  });

  it("drops the visit from the queue once it is billed", async () => {
    // The queue is "charges on no bill". Finalizing moved all three onto one, so there is
    // nothing left here — and a row that lingered would invite a second bill for the same tests.
    const res = await pendingAs(cashierToken).expect(200);
    expect(res.body.data.map((r: { encounterId: string }) => r.encounterId)).not.toContain(
      encounterId,
    );
  });

  it("brings it BACK when the doctor orders something else", async () => {
    // Per-batch billing: a charge arriving after a bill is issued lands on the NEXT bill. The
    // counter has to see that, or the second test is run and never paid for.
    await orderTest({ encounterId, patientId, episodeId }, "TSH");

    const res = await pendingAs(cashierToken).expect(200);
    const row = (res.body.data as { encounterId: string; amount: number; count: number }[]).find(
      (r) => r.encounterId === encounterId,
    );
    expect(row).toMatchObject({ amount: 45_000, count: 1 });
  });

  it("does not count a voided charge — a reversed charge is not owed", async () => {
    const charges = await auth(
      request(app).get(`/api/v1/encounters/${encounterId}/charges`),
      pvt,
    ).expect(200);
    const tsh = (charges.body.data as { id: string; code: string; invoiceId?: string }[]).find(
      (c) => c.code === "TSH" && !c.invoiceId,
    );

    await auth(request(app).post(`/api/v1/charges/${tsh?.id}/void`), pvt)
      .send({ reason: "ordered in error" })
      .expect(200);

    const res = await pendingAs(cashierToken).expect(200);
    expect(res.body.data.map((r: { encounterId: string }) => r.encounterId)).not.toContain(
      encounterId,
    );
  });

  it("still lists a charge that carries NO branchId at all, WITH a branch selected", async () => {
    /**
     * ── THE FALSIFICATION ───────────────────────────────────────────────────
     * The obvious implementation adds `scopeFilter()` to the aggregation, and it is wrong. A
     * charge posted by an event consumer carries a `branchId` only when the event envelope had
     * one (`onOrderPlaced`), so a branch filter silently drops real money from the ONE list whose
     * job is to find money nobody has billed. Same shape as filtering vitals on their own
     * optional branch stamp: the filter hides exactly the rows it could least afford to hide.
     *
     * The branch header is what makes this a test rather than a hope. `scopeFilter()` returns
     * `{}` when no branch is selected, so without `X-Active-Branch` a wrongly-added filter would
     * be inert here and this test would pass against the bug. With Main Branch selected it
     * returns `{ branchId }`, no charge in this suite carries one, and the queue goes empty.
     *
     * Measured: adding `...scopeFilter()` to the $match turns this test red and leaves the other
     * seven green.
     */
    const branches = await auth(request(app).get("/api/v1/branches"), pvt).expect(200);
    const mainBranchId = (branches.body.data as { id: string; isMain?: boolean }[])[0]?.id;
    expect(mainBranchId).toBeTruthy();

    const visit = await arrive(pvt, "No Branch Stamp", "9000100201");
    await asRelay(pvt, () => dispatchEventInline(visit.event));

    const charges = await auth(
      request(app).get(`/api/v1/encounters/${visit.encounterId}/charges`),
      pvt,
    ).expect(200);
    expect(charges.body.data[0].branchId).toBeUndefined();

    const res = await pendingAs(cashierToken, "", mainBranchId).expect(200);
    expect(res.body.data.map((r: { encounterId: string }) => r.encounterId)).toContain(
      visit.encounterId,
    );
  });
});

/**
 * ── SETTLING AN ADMITTED PATIENT'S TEST FROM AN ADVANCE THAT CANNOT COVER IT ──
 *
 * WHAT DEFECT WOULD THIS CATCH? The one that was live when this was written.
 *
 * `debitForInvoice` takes `allowNegative` for one documented reason: "so an inpatient's test is
 * never held for want of advance (the shortfall is collected later)". That path could not
 * succeed. The account went negative — its `min: 0` does not run on the `$inc` that moves it —
 * and then the LEDGER refused to record the balance the account had just reached, because
 * `walletEntries.balanceAfter` carried `min: 0`. Mongoose threw a ValidationError from inside the
 * transaction, it escaped as an unhandled **HMS-GEN-500**, and the whole settlement rolled back.
 *
 * So the button the lab and imaging worklists both offer — "Proceed — deduct ₹x" — crashed for
 * every admitted patient whose advance was short, which includes every admitted patient whose
 * advance is zero. It had no behavioural test: `settle-from-advance` was covered by an RBAC probe
 * and nothing else, and a probe asserts who is refused, never that the thing works.
 *
 * Found by the radiology browser spec, which is the first test in this repository ever to press
 * that button. It is a BILLING defect and it was never radiology's — imaging only walked the path
 * first.
 */
describe("an admitted patient's test settles even when the advance is short", () => {
  let encounterId = "";
  let patientId = "";
  let episodeId = "";
  let orderId = "";

  const oid = (): string =>
    [...Array<number>(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");

  beforeAll(async () => {
    const arrived = await arrive(pvt, "Advance Short", "9000009901");
    encounterId = arrived.encounterId;
    patientId = arrived.patientId;
    episodeId = arrived.event.payload.episodeId as string;

    /**
     * ADMITTED. The whole path is inpatient-only by design — an outpatient with no advance is
     * asked to pay at the counter, and `settleOrderFromAdvance` refuses them with a 422 saying
     * exactly that. The bed is free text: no bed inventory is needed to be an inpatient.
     *
     * Admission opens a NEW encounter (ADR-0013 §4: same episode, different visit), so the charge
     * below hangs off the IP one. Raising it against the OP encounter would have produced a charge
     * on a visit whose class is `OP`, and the settlement would have refused it — correctly, and
     * for a reason that has nothing to do with what this block is testing.
     */
    // The visit has to be UNDER WAY: `admit` moves a live consultation onto a ward, and an
    // encounter still sitting at `arrived` has not begun.
    await auth(request(app).post(`/api/v1/encounters/${encounterId}/start`), pvt).expect(200);

    const admitted = await auth(request(app).post(`/api/v1/encounters/${encounterId}/admit`), pvt)
      .send({ ward: "General Ward", bedCode: "GW-11", tariffCode: "BED_GEN" })
      .expect(201);
    encounterId = admitted.body.data.inpatient.id as string;

    // A charge, raised the way the relay raises one when a doctor's order commits.
    orderId = oid();
    await asRelay(pvt, () =>
      dispatchEventInline({
        eventId: `evt-adv-${orderId}`,
        name: "order.order.placed",
        version: 1,
        tenantId: pvt.id,
        occurredAt: new Date().toISOString(),
        payload: {
          orderId,
          encounterId,
          patientId,
          episodeId,
          code: "XRAY_CHEST_PA",
          name: "X-ray Chest PA View",
          category: "radiology",
        },
      }),
    );
  }, 60_000);

  /** The premise: a real, unpaid, priced charge. Without it the settlement below settles nothing. */
  it("has something to settle, and the patient has nothing to settle it with", async () => {
    const state = await auth(
      request(app).get(`/api/v1/billing/order-payments?orderIds=${orderId}`),
      pvt,
    ).expect(200);
    expect(["unpaid", "unbilled"]).toContain((state.body.data as Record<string, string>)[orderId]);

    const wallet = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), pvt).expect(
      200,
    );
    expect(wallet.body.data.balance).toBe(0);
  });

  it("settles it, and says how far into the red it went", async () => {
    const settled = await auth(
      request(app).post(`/api/v1/billing/orders/${orderId}/settle-from-advance`),
      pvt,
    ).expect(200);

    // The X-ray is ₹450. An empty advance therefore ends at −₹450, which is a debt, not an error.
    expect(settled.body.data.advanceBalance).toBeLessThan(0);
    expect(settled.body.data.orderId).toBe(orderId);
  });

  /**
   * ── THE TWO COLLECTIONS AGREE ───────────────────────────────────────────────
   * `wallet.model.ts` opens by saying the account and the ledger move together, in one
   * transaction. The defect broke exactly that: the account reached a balance the ledger was
   * forbidden to write down. Asserting the number in BOTH places is what makes this a test of the
   * invariant rather than of the endpoint's status code.
   */
  it("records the negative balance in the ledger as well as the account", async () => {
    const wallet = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), pvt).expect(
      200,
    );
    expect(wallet.body.data.balance).toBeLessThan(0);

    const debit = (wallet.body.data.entries as { type: string; balanceAfter: number }[]).find(
      (e) => e.type === "debit",
    );
    expect(
      debit,
      "the wallet was debited with no ledger row — the money left no trace",
    ).toBeTruthy();
    expect(debit!.balanceAfter).toBe(wallet.body.data.balance);
  });

  /** And the test is paid for, which is the point of the button. */
  it("leaves the study paid, so the worklist stops holding it", async () => {
    const state = await auth(
      request(app).get(`/api/v1/billing/order-payments?orderIds=${orderId}`),
      pvt,
    ).expect(200);
    expect((state.body.data as Record<string, string>)[orderId]).toBe("paid");
  });

  /** Pressing it twice must not debit twice — the settlement is keyed on the invoice. */
  it("is safe to press twice", async () => {
    const before = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), pvt).expect(
      200,
    );
    await auth(
      request(app).post(`/api/v1/billing/orders/${orderId}/settle-from-advance`),
      pvt,
    ).expect(200);
    const after = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), pvt).expect(
      200,
    );
    expect(after.body.data.balance).toBe(before.body.data.balance);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * CARE PACKAGES ARE A MODULE THE HOSPITAL BUYS — layer 1, not layer 2.
 *
 * `module.finance.packages` is sold in three editions (Day Care, Hospital Plus, Enterprise) and,
 * until 2026-08-20, gated nothing: the six package routes carried `module.ops.opd` like the rest
 * of billing, which every edition holds. So both hospitals in this suite — PLAN_HOSPITAL, which
 * does NOT include packages — could define a maternity bundle and enrol patients into it, and the
 * flag sat on their subscription page as a module they had not bought.
 *
 * The regression is asserted on the CODE, not the status. `HMS-PLAN-002` and `HMS-AUTH-005` are
 * both 403s and mean opposite things: one sends the administrator to their account manager, the
 * other sends them into the role editor after a permission that can never help. A test that
 * accepted either would pass just as happily if this were re-gated to a permission nobody holds.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("care packages: a hospital that did not buy them cannot use them", () => {
  const ID = "64b7f0000000000000000001";
  const ROUTES: [string, () => request.Test][] = [
    ["GET /packages", () => request(app).get("/api/v1/packages")],
    ["POST /packages", () => request(app).post("/api/v1/packages")],
    ["PATCH /packages/:id", () => request(app).patch(`/api/v1/packages/${ID}`)],
    [
      "GET /encounters/:id/package-enrollments",
      () => request(app).get(`/api/v1/encounters/${ID}/package-enrollments`),
    ],
    [
      "POST /encounters/:id/package-enrollments",
      () => request(app).post(`/api/v1/encounters/${ID}/package-enrollments`),
    ],
    [
      "POST /package-enrollments/:id/cancel",
      () => request(app).post(`/api/v1/package-enrollments/${ID}/cancel`),
    ],
  ];

  /**
   * Every route, not just the list. A gate on the read but not the write is worse than no gate:
   * the hospital simply uses the parts that were forgotten, and the catalogue it cannot see fills
   * up anyway.
   */
  it.each(ROUTES)("refuses %s with HMS-PLAN-002", async (_name, call) => {
    const res = await auth(call(), pvt).send({});
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("HMS-PLAN-002");
    expect(res.body.error?.details?.feature).toBe("module.finance.packages");
  });

  /**
   * The other half, and the half that proves this is an ENTITLEMENT and not an accident: the same
   * hospital, the same administrator, the same request — with the module switched on through the
   * mechanism that already exists for it (a per-tenant override, `featureFlags` in the master
   * registry). Nothing about the user changed, so nothing but layer 1 can explain the difference.
   */
  it("admits the same hospital once the module is switched on for it", async () => {
    await setFeatureOverride({
      tenantId: pvt.id,
      flag: "module.finance.packages",
      enabled: true,
      reason: "billing.int.test — proving the gate is layer 1",
    });
    try {
      const res = await auth(request(app).get("/api/v1/packages"), pvt);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    } finally {
      await clearFeatureOverride(pvt.id, "module.finance.packages");
    }
  });

  /** And withdrawing it takes the module away again — the cache must not outlive the entitlement. */
  it("takes it away again when the override is cleared", async () => {
    const res = await auth(request(app).get("/api/v1/packages"), pvt);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("HMS-PLAN-002");
  });

  /**
   * The rest of billing is NOT a package. `module.ops.opd` still gates the counter, so re-gating
   * the packages must not have taken the tariff or the bill with it — the failure this would
   * catch is a one-line mistake with a very large blast radius.
   */
  it("leaves the rest of billing untouched for the same hospital", async () => {
    await auth(request(app).get("/api/v1/services"), pvt).expect(200);
    await auth(request(app).get("/api/v1/invoices"), pvt).expect(200);
  });
});
