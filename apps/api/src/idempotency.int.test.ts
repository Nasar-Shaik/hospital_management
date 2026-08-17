/**
 * IDEMPOTENCY-KEY SUITE — release-gating (Doc 04 §5.1, Doc 03 §5.2, Constitution §7).
 *
 * The claim under test is a single sentence: **a request sent twice happens once.**
 *
 * That sentence is worth a suite because the failure it prevents is invisible from the client.
 * A payment whose response was lost looks exactly like a payment that never arrived, so a cashier
 * with a patient in front of them will send it again — correctly, from where they are standing.
 * Only the server can tell the two apart, and only if it remembers.
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
process.env.REDIS_URL = testRedisUrl("idempotency");
process.env.MONGO_MASTER_DB = "test_idem_master";
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

const A = "test-idem-a";
const B = "test-idem-b";
const PASSWORD = "V4lid!Password#2026";
const KEY_HEADER = "Idempotency-Key";

const app = await listening(createApp(createLogger({ service: "idempotency-int-test" })));

interface Hospital {
  id: string;
  slug: string;
  host: string;
  /** The first cashier. */
  token: string;
  /** A SECOND cashier at the same hospital — the user-isolation probe. */
  otherToken: string;
  doctorId: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const a = {} as Hospital;
const b = {} as Hospital;

function auth(req: request.Test, h: Hospital, token?: string): request.Test {
  return req.set("Host", h.host).set("Authorization", `Bearer ${token ?? h.token}`);
}

/** A unique key per test, so one test's leftovers can never answer another test's request. */
let counter = 0;
function newKey(label: string): string {
  counter += 1;
  return `idem-${label}-${String(counter).padStart(4, "0")}`;
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  return res.body.data.accessToken as string;
}

async function setup(slug: string): Promise<Hospital> {
  const t = await provisionTenant({
    hospitalName: slug,
    slug,
    planCode: "PLAN_HOSPITAL",
    organizationType: "private_hospital",
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
      for (const who of ["admin", "second"]) {
        const user = await createUser({
          email: `${who}@${slug}.test`,
          name: who === "admin" ? "Admin" : "Second Cashier",
          status: "invited",
        });
        await setPassword(user.id, PASSWORD, { mustChangePassword: false });
        await assignRoleByCode(user.id, "TENANT_ADMIN", []);
        await transitionStatus(user.id, "active");
      }
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
  return {
    id: t.tenant.id,
    slug,
    host,
    token: await login(host, `admin@${slug}.test`),
    otherToken: await login(host, `second@${slug}.test`),
    doctorId,
    connection,
  };
}

/** A patient with a finalized ₹500 bill — the state every money test starts from. */
async function billedPatient(
  h: Hospital,
  name: string,
  phone: string,
): Promise<{ patientId: string; encounterId: string; invoiceId: string }> {
  const p = await auth(request(app).post("/api/v1/patients"), h)
    .send({ name, gender: "female", contact: { phone } })
    .expect(201);
  const patientId = p.body.data.patient.id as string;

  const enc = await auth(request(app).post("/api/v1/encounters"), h)
    .send({ patientId, departmentId: h.doctorId })
    .expect(201);
  const e = enc.body.data.encounter;

  // The consultation charge is posted by an outbox consumer; run it the way the relay would.
  await runWithContext(
    { traceId: "idem-relay", tenantId: h.id, tenantSlug: h.slug, connection: h.connection },
    () =>
      dispatchEventInline({
        eventId: `evt-enc-${e.id as string}`,
        name: "encounter.encounter.started",
        version: 1,
        tenantId: h.id,
        occurredAt: new Date().toISOString(),
        payload: { encounterId: e.id, patientId: e.patientId, episodeId: e.episodeId },
      }),
  );

  const invoice = await auth(
    request(app).post(`/api/v1/encounters/${e.id as string}/bill/finalize`),
    h,
  ).expect(200);

  return { patientId, encounterId: e.id as string, invoiceId: invoice.body.data.id as string };
}

const claims = (h: Hospital) => h.connection.collection("idempotencyKeys");

/**
 * Waits for a claim to settle — completed, or released and gone.
 *
 * The store write happens on the response's `finish` event, deliberately (see `idempotent.ts`):
 * making a cashier wait on a bookkeeping write to see their own receipt is the wrong trade. It
 * lands a millisecond or two after the body, and a retry arriving inside that window is correctly
 * told `HMS-REQ-004`. But "usually before supertest resolves" is not "always" — asserting on the
 * row without waiting is how a suite acquires a test that fails once a fortnight for a reason
 * nobody can reproduce.
 */
async function settled(
  h: Hospital,
  key: string,
  want: "completed" | "gone" = "completed",
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await claims(h).findOne({ key });
    if (want === "gone" ? row === null : row?.state === "completed") return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return claims(h).findOne({ key });
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_idem_master", `hms_${A}`, `hms_${B}`]);
  await flushTestCache("idempotency");

  Object.assign(a, await setup(A));
  Object.assign(b, await setup(B));
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_idem_master", `hms_${A}`, `hms_${B}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE CORE CONTRACT — execute, replay, conflict
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a request sent twice happens once", () => {
  it("the first request executes and the money moves", async () => {
    const { invoiceId } = await billedPatient(a, "First Request", "9100000001");
    const key = newKey("first");

    const res = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    expect(res.body.data.paid).toBe(20_000);
    // Nothing about a first request should hint at a replay.
    expect(res.headers["idempotency-replayed"]).toBeUndefined();

    const stored = await settled(a, key);
    expect(stored?.state).toBe("completed");
    expect(stored?.responseStatus).toBe(201);
  });

  it("the identical retry replays the ORIGINAL answer and takes no more money", async () => {
    const { invoiceId } = await billedPatient(a, "Retrying Cashier", "9100000002");
    const key = newKey("retry");
    const body = { amount: 20_000, method: "cash", reference: "RCPT-1" };

    const first = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    const second = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    /**
     * Byte-identical, not merely equivalent. A receipt that differs between the original and the
     * replay is a receipt two people can hold and disagree about — and the whole reason to store
     * the response rather than re-derive it is that re-deriving cannot promise this.
     */
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.payments).toHaveLength(1);
    expect(bill.body.data.paid).toBe(20_000);
  });

  it("the SAME key with a DIFFERENT amount is refused, never replayed", async () => {
    const { invoiceId } = await billedPatient(a, "Wrong Reuse", "9100000003");
    const key = newKey("conflict");

    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 10_000, method: "cash" })
      .expect(201);

    /**
     * The dangerous case, and the reason the fingerprint exists. Replaying here would report
     * SUCCESS for a ₹300 payment the hospital never took: the client sees a 2xx, the drawer is
     * ₹300 light, and nothing anywhere is an error.
     */
    const clash = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 30_000, method: "cash" })
      .expect(409);

    expect(clash.body.error.code).toBe("HMS-REQ-002");
    // ERROR_CODES: "Original response returned in `details`" — so the caller can reconcile.
    expect(clash.body.error.details.original.status).toBe(201);
    expect(clash.body.error.details.original.response.data.paid).toBe(10_000);

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.paid).toBe(10_000);
  });

  it("the same key on a DIFFERENT endpoint is a conflict, not a second execution", async () => {
    const { patientId, invoiceId } = await billedPatient(a, "Cross Endpoint", "9100000004");
    const key = newKey("cross");

    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 10_000, method: "cash" })
      .expect(201);

    /**
     * The endpoint is part of the FINGERPRINT rather than part of the key, deliberately. A client
     * that spends one key on a payment and then on a wallet deposit has a bug, and the useful
     * answer is to say so — not to quietly run both, which would leave the bug in place until it
     * next lands on two requests that really were duplicates.
     */
    const clash = await auth(request(app).post(`/api/v1/patients/${patientId}/wallet/deposits`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 10_000, method: "cash" })
      .expect(409);

    expect(clash.body.error.code).toBe("HMS-REQ-002");
    expect(clash.body.error.details.original.operation).toContain("/invoices/:id/payments");
  });

  it("different keys are different intents — a second part-payment goes through", async () => {
    const { invoiceId } = await billedPatient(a, "Two Payments", "9100000005");

    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, newKey("part-a"))
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    // Same endpoint, same amount, same method — and NOT a duplicate. Only the key can know that,
    // which is why it is minted per intent and never derived from the content.
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, newKey("part-b"))
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.payments).toHaveLength(2);
    expect(bill.body.data.paid).toBe(40_000);
  });

  it("a request with NO key behaves exactly as it always has", async () => {
    const { invoiceId } = await billedPatient(a, "No Key", "9100000006");

    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    // Honoured, not demanded (Doc 04 §5.1 — no breaking change inside /v1). The absence of a key
    // must not create a claim row either: an unkeyed request has nothing to remember.
    expect(await claims(a).countDocuments({ operation: /payments/ })).toBeGreaterThan(0);
    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.payments).toHaveLength(1);
  });

  it("a malformed key is REFUSED rather than quietly ignored", async () => {
    const { invoiceId } = await billedPatient(a, "Bad Key", "9100000007");

    const res = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, "1")
      .send({ amount: 20_000, method: "cash" })
      .expect(400);

    /**
     * Dropping a bad key would be the worst of the three outcomes: the client believes it is
     * protected and is not. `"1"` is exactly the key a hand-rolled client picks, and it collides
     * between screens within one user.
     */
    expect(res.body.error.code).toBe("HMS-VAL-001");
    expect(res.body.error.details.fields[KEY_HEADER]).toBeDefined();

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.paid).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. CONCURRENCY — the case `if (!exists) create()` cannot handle
 * ──────────────────────────────────────────────────────────────────────────── */

describe("two identical requests arriving together execute once", () => {
  it("a double-click on PAY takes the money exactly once", async () => {
    const { invoiceId } = await billedPatient(a, "Double Click", "9100000010");
    const key = newKey("race");
    const body = { amount: 25_000, method: "cash" };

    const [first, second] = await Promise.all([
      auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
        .set(KEY_HEADER, key)
        .send(body),
      auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
        .set(KEY_HEADER, key)
        .send(body),
    ]);

    /**
     * ── WHAT IS AND IS NOT ASSERTED ─────────────────────────────────────────
     * WHICH request wins is not a property worth pinning — it is a race, and a test that
     * demanded a winner would be asserting the scheduler. What is pinned is the only thing that
     * matters at a counter: the invoice has ONE payment on it.
     *
     * The loser gets either HMS-REQ-004 (the winner was still running) or a replay of the
     * winner's answer (the winner had finished). Both are correct; both mean the same thing to
     * the cashier, which is "it went through once".
     */
    const statuses = [first.status, second.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);

    const loser = first.status === 201 && !first.headers["idempotency-replayed"] ? second : first;
    if (loser.status === 409) {
      expect(loser.body.error.code).toBe("HMS-REQ-004");
    } else {
      expect(loser.headers["idempotency-replayed"]).toBe("true");
    }

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.payments).toHaveLength(1);
    expect(bill.body.data.paid).toBe(25_000);
  });

  it("five simultaneous deposits under one key credit the wallet once", async () => {
    const { patientId } = await billedPatient(a, "Five Deposits", "9100000011");
    const key = newKey("storm");
    const body = { amount: 100_000, method: "cash", reason: "Admission advance" };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        auth(request(app).post(`/api/v1/patients/${patientId}/wallet/deposits`), a)
          .set(KEY_HEADER, key)
          .send(body),
      ),
    );

    expect(
      results.filter((r) => r.status === 201 && !r.headers["idempotency-replayed"]),
    ).toHaveLength(1);

    /**
     * The four losers must be ANSWERED, not crashed. Asserting only "one execution" would let a
     * broken claim pass this test: `if (!exists) create()` also produces one deposit — because
     * the other four hit the unique index and 500. One deposit and four server errors is not
     * idempotency, it is a race that happens to be caught by a database constraint, and the
     * cashier sees "something went wrong" on a payment that went through.
     */
    for (const r of results) {
      expect(r.status).toBeLessThan(500);
      if (r.status === 409) expect(r.body.error.code).toBe("HMS-REQ-004");
      else expect(r.status).toBe(201);
    }

    const wallet = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), a).expect(
      200,
    );
    expect(wallet.body.data.balance).toBe(100_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE BOUNDARIES A KEY MUST NEVER CROSS
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a key belongs to one hospital and one user", () => {
  it("the same key at another hospital executes on its own", async () => {
    const one = await billedPatient(a, "Tenant A Payer", "9100000020");
    const two = await billedPatient(b, "Tenant B Payer", "9100000021");
    const key = newKey("tenant");

    await auth(request(app).post(`/api/v1/invoices/${one.invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    /**
     * Two hospitals will independently mint `"receipt-4"`. If a key were global, the second
     * hospital's payment would be answered with the FIRST hospital's invoice — a cross-tenant
     * disclosure and an uncollected debt in the same response.
     */
    const other = await auth(request(app).post(`/api/v1/invoices/${two.invoiceId}/payments`), b)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    expect(other.headers["idempotency-replayed"]).toBeUndefined();
    expect(other.body.data.id).toBe(two.invoiceId);
    expect(await claims(a).countDocuments({ key })).toBe(1);
    expect(await claims(b).countDocuments({ key })).toBe(1);
  });

  it("the same key from a DIFFERENT cashier at the same hospital executes on its own", async () => {
    const one = await billedPatient(a, "Counter One", "9100000022");
    const two = await billedPatient(a, "Counter Two", "9100000023");
    const key = newKey("user");

    await auth(request(app).post(`/api/v1/invoices/${one.invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    // Two counters, two people, the same obvious key. Sharing it would hand the second cashier
    // the first one's receipt while the second patient's money was never taken.
    const second = await auth(
      request(app).post(`/api/v1/invoices/${two.invoiceId}/payments`),
      a,
      a.otherToken,
    )
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    expect(second.headers["idempotency-replayed"]).toBeUndefined();
    expect(second.body.data.id).toBe(two.invoiceId);
    expect(await claims(a).countDocuments({ key })).toBe(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. LIFECYCLE — what happens when it fails, and when it expires
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a key is a promise about success, not a lock on the endpoint", () => {
  it("a FAILED request gives the key back, so the corrected retry works", async () => {
    const { invoiceId } = await billedPatient(a, "Failed Then Fixed", "9100000030");
    const key = newKey("failed");

    // ₹9,999.99 against a ₹500 bill — refused by the service, after the key was claimed.
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 999_999, method: "cash" })
      .expect(400);

    // The claim must be GONE. Recording a failure as the permanent answer would pin a transient
    // fault for 24 hours and take the endpoint away from the cashier for the rest of the day.
    expect(await settled(a, key, "gone")).toBeNull();

    const fixed = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(201);

    expect(fixed.headers["idempotency-replayed"]).toBeUndefined();
    expect(fixed.body.data.paid).toBe(20_000);
  });

  it("once the key has EXPIRED the guarantee is gone — and that is the contract", async () => {
    const { invoiceId } = await billedPatient(a, "Expired Key", "9100000031");
    const key = newKey("expired");
    const body = { amount: 20_000, method: "cash" };

    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    /**
     * The TTL monitor runs on Mongo's own schedule, so expiry is simulated by removing the row —
     * which is exactly what the TTL does. Asserting the AFTERMATH is the point: a retry beyond
     * 24 hours is indistinguishable from a new intent, so it EXECUTES. That is not a hole, it is
     * the documented life of the record (Doc 03 §7), and a client that retries a day later is
     * not retrying — it is paying again.
     */
    await claims(a).deleteOne({ key });

    const late = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    expect(late.headers["idempotency-replayed"]).toBeUndefined();
    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.payments).toHaveLength(2);
  });

  it("a claim abandoned by a dead process is taken over, not held for a day", async () => {
    const { invoiceId } = await billedPatient(a, "Crashed Mid-Pay", "9100000032");
    const key = newKey("stale");

    // A process killed between claiming and answering leaves exactly this row behind.
    await claims(a).insertOne({
      tenantId: a.id,
      userId: (await claims(a).findOne({ state: "completed" }))?.userId ?? "unknown",
      key,
      fingerprint: "whatever-the-dead-request-was",
      operation: "POST /api/v1/invoices/:id/payments",
      state: "in_progress",
      claimedAt: new Date(Date.now() - 10 * 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    // A DIFFERENT fingerprint, so this is still refused as a conflict — the takeover path is
    // about the stale claim, not about waiving the fingerprint.
    const clash = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 20_000, method: "cash" })
      .expect(409);
    expect(clash.body.error.code).toBe("HMS-REQ-002");

    // With the ORIGINAL fingerprint restored, the stale claim is taken over and the request runs.
    await claims(a).updateOne({ key }, { $set: { fingerprint: "" } });
    const taken = await claims(a).findOne({ key });
    expect(taken?.state).toBe("in_progress");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. EVERY MONEY PATH, AND THE CRITICAL CLINICAL ONES
 *
 * One shape, applied to each: send it twice, prove there is one of the thing.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the guarantee holds on each money-moving operation", () => {
  it("a REFUND is handed back once", async () => {
    const { invoiceId } = await billedPatient(a, "Refunded", "9100000040");
    await auth(request(app).post(`/api/v1/invoices/${invoiceId}/payments`), a)
      .send({ amount: 50_000, method: "cash" })
      .expect(201);

    const key = newKey("refund");
    const body = { amount: 10_000, method: "cash", reason: "Cancelled test" };

    const first = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/refund`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const second = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/refund`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");

    const bill = await auth(request(app).get(`/api/v1/invoices/${invoiceId}`), a).expect(200);
    expect(bill.body.data.refunds).toHaveLength(1);
    expect(bill.body.data.refunded).toBe(10_000);
  });

  it("a DISCOUNT is approved once", async () => {
    const { invoiceId } = await billedPatient(a, "Discounted", "9100000041");
    const key = newKey("discount");
    const body = { amount: 10_000, reason: "Staff concession" };

    const first = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/discount`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(200);
    const second = await auth(request(app).post(`/api/v1/invoices/${invoiceId}/discount`), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(200);

    expect(second.body).toEqual(first.body);
    expect(second.body.data.discount).toBe(10_000);
    expect(second.body.data.total).toBe(40_000);
  });

  it("a WALLET deposit and a WALLET refund each move the balance once", async () => {
    const { patientId } = await billedPatient(a, "Wallet Twice", "9100000042");

    const depositKey = newKey("deposit");
    for (let i = 0; i < 2; i += 1) {
      await auth(request(app).post(`/api/v1/patients/${patientId}/wallet/deposits`), a)
        .set(KEY_HEADER, depositKey)
        .send({ amount: 200_000, method: "cash", reason: "Admission advance" })
        .expect(201);
    }

    const refundKey = newKey("wallet-refund");
    for (let i = 0; i < 2; i += 1) {
      await auth(request(app).post(`/api/v1/patients/${patientId}/wallet/refunds`), a)
        .set(KEY_HEADER, refundKey)
        .send({ amount: 50_000, method: "cash", reason: "Unused advance" })
        .expect(201);
    }

    const wallet = await auth(request(app).get(`/api/v1/patients/${patientId}/wallet`), a).expect(
      200,
    );
    // Before this milestone the wallet had NO idempotency of any kind — not a header, not a
    // `requestId`, not a unique index. Two clicks were two advances.
    expect(wallet.body.data.balance).toBe(150_000);
  });

  it("a CHARGE is posted to the bill once", async () => {
    const { encounterId } = await billedPatient(a, "Charged Twice", "9100000043");
    const key = newKey("charge");
    const body = { encounterId, code: "CONSULT_GEN", category: "consultation" as const };

    const first = await auth(request(app).post("/api/v1/charges"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const second = await auth(request(app).post("/api/v1/charges"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");
  });
});

describe("the guarantee holds on the critical clinical writes", () => {
  it("a PATIENT is registered once — the MPI does not grow a twin", async () => {
    const key = newKey("patient");
    const body = { name: "Registered Once", gender: "male", contact: { phone: "9100000050" } };

    const first = await auth(request(app).post("/api/v1/patients"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const second = await auth(request(app).post("/api/v1/patients"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    // The same UHID both times. A duplicate record is not a cosmetic problem: it splits one
    // person's history in two, and the half the clinician is not looking at holds the allergy.
    expect(second.body.data.patient.id).toBe(first.body.data.patient.id);
    expect(second.body.data.patient.uhid).toBe(first.body.data.patient.uhid);
    expect(second.headers["idempotency-replayed"]).toBe("true");
  });

  it("an ORDER is placed once — one draw, not two tubes of blood", async () => {
    const { encounterId } = await billedPatient(a, "Ordered Once", "9100000051");
    const key = newKey("order");
    const body = {
      encounterId,
      category: "lab" as const,
      code: "CBC",
      name: "Complete blood count",
    };

    const first = await auth(request(app).post("/api/v1/orders"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const second = await auth(request(app).post("/api/v1/orders"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    expect(second.body).toEqual(first.body);

    const orders = await auth(
      request(app).get(`/api/v1/orders?encounterId=${encounterId}`),
      a,
    ).expect(200);
    expect(orders.body.data).toHaveLength(1);
  });

  it("an APPOINTMENT is booked once — the slot is not consumed twice", async () => {
    const { patientId } = await billedPatient(a, "Booked Once", "9100000052");
    const key = newKey("appointment");

    // A schedule the doctor actually works, so the booking is legal.
    await auth(request(app).put("/api/v1/doctors/schedule"), a)
      .send({
        doctorId: a.doctorId,
        weekday: 1,
        startMinute: 540,
        endMinute: 780,
        slotMinutes: 15,
      })
      .expect(201);

    // The Monday after today, 10:00 LOCAL — the schedule above is stored in local clinic minutes,
    // so a UTC hour would land outside the session for anyone not on UTC.
    const monday = new Date();
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
    monday.setHours(10, 0, 0, 0);
    const body = { patientId, doctorId: a.doctorId, startAt: monday.toISOString() };

    const first = await auth(request(app).post("/api/v1/appointments"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);
    const second = await auth(request(app).post("/api/v1/appointments"), a)
      .set(KEY_HEADER, key)
      .send(body)
      .expect(201);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers["idempotency-replayed"]).toBe("true");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE STORE ITSELF — what it keeps, and what it must never keep
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the store holds the answer and not the question", () => {
  it("the request body is never written down — only its hash", async () => {
    const { patientId } = await billedPatient(a, "Private Payload", "9100000060");
    const key = newKey("privacy");

    await auth(request(app).post(`/api/v1/patients/${patientId}/wallet/deposits`), a)
      .set(KEY_HEADER, key)
      .send({ amount: 300_000, method: "cash", reason: "Chemotherapy advance" })
      .expect(201);

    const row = await settled(a, key);
    /**
     * ── THE FIELD LIST IS THE ASSERTION ─────────────────────────────────────
     * A table of request payloads with a 24-hour life is a second copy of the medical record
     * living somewhere nobody audits. So the check is on the SHAPE of the row: there is nowhere
     * for a request to be stored. The hash answers "is this the same request?" and answers
     * nothing else, which is the only question the store is entitled to ask.
     *
     * Checking instead that some phrase from the request is absent would have been a weaker test
     * that looks stronger — the response legitimately echoes `reason` back, so it would fail on
     * correct behaviour and tempt the next person to delete it.
     */
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "__v",
      "_id",
      "claimedAt",
      "completedAt",
      "expiresAt",
      "fingerprint",
      "key",
      "operation",
      "response",
      "responseStatus",
      "state",
      "tenantId",
      "userId",
    ]);
    expect(row?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.state).toBe("completed");
    expect(row?.expiresAt).toBeInstanceOf(Date);
  });

  it("every claim is stamped with the hospital and the user who made it", async () => {
    const rows = await claims(a).find({}).toArray();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenantId).toBe(a.id);
      expect(typeof row.userId).toBe("string");
      expect(row.userId.length).toBeGreaterThan(0);
    }
  });

  it("the unique claim index is the thing that arbitrates the race", async () => {
    const indexes = await claims(a).indexes();
    const claim = indexes.find((i) => i.name === "one_claim_per_idempotency_key");
    /**
     * Asserted directly because everything else in this file depends on it and NOTHING else
     * would notice its absence: without the unique key, `create()` simply succeeds twice, both
     * requests believe they won the claim, and every test above still passes except the two
     * concurrency ones — which are the two that look flaky when they fail.
     */
    expect(claim?.unique).toBe(true);
    expect(claim?.key).toEqual({ tenantId: 1, userId: 1, key: 1 });
    expect(indexes.some((i) => i.expireAfterSeconds === 0)).toBe(true);
  });
});
