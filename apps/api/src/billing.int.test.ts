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

const PVT = "test-bill-pvt";
const GOV = "test-bill-gov";
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "billing-int-test" }));

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
