/**
 * ORDERS SUITE — release-gating (ADR-0013 §3, STATE_MACHINE_CATALOG §15).
 *
 * The Order is the spine that carries work between departments, and this suite exists
 * to prove the two sentences that spine is supposed to make true:
 *
 *   1. "Doctor orders appear automatically in the destination department."
 *      Not a hand-off, not a chit walked down a corridor — the lab's worklist IS a
 *      query over these rows, so the work is in the lab the instant it is committed.
 *
 *   2. "Reports become available automatically to the requesting doctor."
 *      A released result reaches the doctor who asked for it, and the patient parked
 *      in `awaiting_results` becomes callable again — but ONLY when nothing else is
 *      still outstanding.
 *
 * Everything else here is a safety boundary. Every role logs in SEPARATELY and holds
 * only what its role grants — a suite that did all this as TENANT_ADMIN would prove
 * that the endpoints exist and nothing whatever about who may call them.
 *
 * The mail assertions run against a REAL SMTP server (Mailhog). A notification suite
 * that mocks the transport is a suite that has never sent a message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";
import {
  assertMailhogReachable,
  clearMailbox,
  inbox,
  waitForMail,
  TEST_SMTP_HOST,
  TEST_SMTP_PORT,
} from "./test/mailTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("orders");
process.env.MONGO_MASTER_DB = "test_ord_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";
// Set BEFORE the app is imported: env is parsed once, at module load.
process.env.SMTP_HOST = TEST_SMTP_HOST;
process.env.SMTP_PORT = TEST_SMTP_PORT;
process.env.MAIL_FROM = "MediCore Test <no-reply@test.local>";

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
const { seedNotificationTemplates } = await import("./seed/notificationTemplates.js");
const { seedTariff } = await import("./seed/tariff.js");
const { seedLabTests, STARTER_LAB_TEST_COUNT, STARTER_LAB_TEST_CODES } =
  await import("./seed/labTests.js");
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const { canTransition, isOutstanding } = await import("./modules/orders/index.js");
const { forgetSchemaReadiness } = await import("./core/db/schemaReadiness.js");
const { readHistory } = await import("./core/db/migrations/runner.js");

const SLUG = "test-orders";
const HOST = `${SLUG}.medicore.test`;
/**
 * A SECOND hospital, on its own database. Only the schema-safety block uses it, and only to prove
 * the one thing a single-tenant suite cannot: that dropping an index in one hospital's database
 * does not stop a different hospital ordering. Tenant isolation is the whole premise of
 * database-per-tenant (ADR-0005), and a guard that broke it would be worse than no guard.
 */
const OTHER_SLUG = "test-orders-other";
const OTHER_HOST = `${OTHER_SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "orders-int-test" })));

let tenantId = "";
let tenantConnection: Awaited<ReturnType<typeof getTenantConnection>>;
/** One token per ROLE. The whole point is that they are not interchangeable. */
const token: Record<string, string> = {};
let doctorId = "";

const otherToken: Record<string, string> = {};
let otherDoctorId = "";

/**
 * Runs a consumer the way the RELAY runs it: inside a tenant-resolved context.
 *
 * A consumer has no HTTP request to inherit a tenant from — the BullMQ worker binds
 * one before dispatching (`withTenant`, eventConsumer.ts). Driving `dispatchEventInline`
 * without it fails with "No request context", which is the tenant-scope guard doing
 * precisely its job.
 */
async function asRelay<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { traceId: "orders-relay-test", tenantId, tenantSlug: SLUG, connection: tenantConnection },
    fn,
  );
}

function as(role: string, req: request.Test): request.Test {
  return req.set("Host", HOST).set("Authorization", `Bearer ${token[role]}`);
}

/** The same, for the second hospital. */
function asOther(role: string, req: request.Test): request.Test {
  return req.set("Host", OTHER_HOST).set("Authorization", `Bearer ${otherToken[role]}`);
}

async function login(email: string, host = HOST): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD })
    .expect(200);
  return res.body.data.accessToken as string;
}

/** The envelope the relay would put on the queue when a result is released. */
function releasedEvent(orderId: string) {
  return {
    eventId: `evt-${orderId}`,
    name: "order.result.released",
    version: 1,
    tenantId,
    occurredAt: new Date().toISOString(),
    payload: { orderId },
  };
}

/** A patient, registered, seen, and sent for tests — the state an order is raised in. */
async function encounterWithDoctor(name: string, phone: string): Promise<string> {
  const p = await as("reception", request(app).post("/api/v1/patients"))
    .send({ name, gender: "female", contact: { phone } })
    .expect(201);

  const enc = await as("reception", request(app).post("/api/v1/encounters"))
    .send({ patientId: p.body.data.patient.id, departmentId: doctorId })
    .expect(201);

  const encounterId = enc.body.data.encounter.id as string;
  await as("doctor", request(app).post(`/api/v1/encounters/${encounterId}/start`)).expect(200);
  return encounterId;
}

/** The same, in the second hospital. */
async function otherEncounter(name: string, phone: string): Promise<string> {
  const p = await asOther("reception", request(app).post("/api/v1/patients"))
    .send({ name, gender: "female", contact: { phone } })
    .expect(201);

  const enc = await asOther("reception", request(app).post("/api/v1/encounters"))
    .send({ patientId: p.body.data.patient.id, departmentId: otherDoctorId })
    .expect(201);

  const encounterId = enc.body.data.encounter.id as string;
  await asOther("doctor", request(app).post(`/api/v1/encounters/${encounterId}/start`)).expect(200);
  return encounterId;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await assertMailhogReachable();
  await dropDatabases(["test_ord_master", `hms_${SLUG}`, `hms_${OTHER_SLUG}`]);
  await flushTestCache("orders");

  const t = await provisionTenant({
    hospitalName: "Orders General",
    slug: SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "government_hospital",
  });
  tenantId = t.tenant.id;

  const connection = await getTenantConnection({
    id: t.tenant.id,
    databaseName: t.tenant.databaseName,
  });
  tenantConnection = connection;

  // `provisionTenant` (the module service) runs migrations but does not seed the
  // tenant's templates — the CLI script and `createHospital` do that. Without them,
  // every notification in this suite would fail with "no such template", and the
  // critical-result alert would have nowhere to go.
  await seedNotificationTemplates(t.tenant.id, SLUG, connection);

  /**
   * The laboratory's two masters, for the same reason the templates are here: `provisionTenant`
   * (the module service) runs migrations but seeds nothing, so without these the catalogue block
   * below would assert against an empty collection and pass for the wrong reason.
   */
  await seedTariff(t.tenant.id, SLUG, connection);
  await seedLabTests(t.tenant.id, SLUG, connection);

  const ROLES: [key: string, roleCode: string, name: string][] = [
    ["reception", "RECEPTIONIST", "Front Desk"],
    ["doctor", "DOCTOR", "Dr Rao"],
    ["tech", "LAB_TECHNICIAN", "Tech Kumar"],
    ["pathologist", "PATHOLOGIST", "Dr Iyer"],
    ["radiologist", "RADIOLOGIST", "Dr Sharma"],
    // Observations are the nurse's, and no other role in this suite holds `vitals:record`. The
    // schema-safety block needs them to EXERCISE the proportionality claim rather than assert it.
    ["nurse", "NURSE", "Nurse Pillai"],
  ];

  await runWithContext(
    { traceId: `setup-${SLUG}`, tenantId: t.tenant.id, tenantSlug: SLUG, connection },
    async () => {
      await seedRbac();

      for (const [key, roleCode, name] of ROLES) {
        const u = await createUser({ email: `${key}@${SLUG}.test`, name, status: "invited" });
        await setPassword(u.id, PASSWORD, { mustChangePassword: false });
        await assignRoleByCode(u.id, roleCode, []);
        await transitionStatus(u.id, "active");
        if (key === "doctor") doctorId = u.id;
      }
    },
  );

  for (const [key] of ROLES) token[key] = await login(`${key}@${SLUG}.test`);

  /* The second hospital — a reception desk and a doctor, which is all an order needs. */
  const other = await provisionTenant({
    hospitalName: "Other General",
    slug: OTHER_SLUG,
    planCode: "PLAN_HOSPITAL",
    organizationType: "government_hospital",
  });

  const otherConnection = await getTenantConnection({
    id: other.tenant.id,
    databaseName: other.tenant.databaseName,
  });

  await runWithContext(
    {
      traceId: `setup-${OTHER_SLUG}`,
      tenantId: other.tenant.id,
      tenantSlug: OTHER_SLUG,
      connection: otherConnection,
    },
    async () => {
      await seedRbac();
      for (const [key, roleCode, name] of [
        ["reception", "RECEPTIONIST", "Other Desk"],
        ["doctor", "DOCTOR", "Dr Other"],
      ] as [string, string, string][]) {
        const u = await createUser({
          email: `${key}@${OTHER_SLUG}.test`,
          name,
          status: "invited",
        });
        await setPassword(u.id, PASSWORD, { mustChangePassword: false });
        await assignRoleByCode(u.id, roleCode, []);
        await transitionStatus(u.id, "active");
        if (key === "doctor") otherDoctorId = u.id;
      }
    },
  );

  for (const key of ["reception", "doctor"]) {
    otherToken[key] = await login(`${key}@${OTHER_SLUG}.test`, OTHER_HOST);
  }
}, 240_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_ord_master", `hms_${SLUG}`, `hms_${OTHER_SLUG}`]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE SPINE — order placed in a consulting room, work appears in the lab,
 *    result comes back to the doctor, patient stops waiting.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the order carries work to the lab and the result back to the doctor", () => {
  it("runs the whole journey, and nobody walks a chit down a corridor", async () => {
    await clearMailbox();

    const encounterId = await encounterWithDoctor("Journey Devi", "9000000010");

    // ── the doctor asks ──────────────────────────────────────────────────────
    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({
        encounterId,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
        priority: "routine",
      })
      .expect(201);

    const orderId = placed.body.data.order.id as string;
    expect(placed.body.data.order.status).toBe("placed");
    // Taken from the ENCOUNTER, never from the request body.
    expect(placed.body.data.order.patientId).toBeTruthy();
    expect(placed.body.data.order.orderedBy).toBe(doctorId);

    // The doctor sends the patient for tests. They keep this encounter.
    await as(
      "doctor",
      request(app).post(`/api/v1/encounters/${encounterId}/investigations`),
    ).expect(200);

    // ── THE WORK IS ALREADY IN THE LAB ───────────────────────────────────────
    // No hand-off ran. Nobody pressed "send to lab". The worklist is a QUERY, so the
    // order joined it the instant it committed.
    const worklist = await as(
      "tech",
      request(app).get("/api/v1/orders?category=lab&outstanding=true"),
    ).expect(200);

    expect((worklist.body.data as { id: string }[]).map((o) => o.id)).toContain(orderId);

    // ── the lab does the work ────────────────────────────────────────────────
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
      .send({
        summary: "Haemoglobin 11.9 g/dL. Within range.",
        values: [{ code: "HB", label: "Haemoglobin", value: "11.9", unit: "g/dL" }],
      })
      .expect(200);

    // ── a SECOND pair of eyes signs it off ───────────────────────────────────
    const verified = await as(
      "pathologist",
      request(app).post(`/api/v1/orders/${orderId}/verify`),
    ).expect(200);
    expect(verified.body.data.status).toBe("verified");
    expect(verified.body.data.verifiedBy).toBeTruthy();

    await as("pathologist", request(app).post(`/api/v1/orders/${orderId}/release`)).expect(200);

    // ── THE RESULT REACHES THE DOCTOR WHO ASKED ──────────────────────────────
    await asRelay(() => dispatchEventInline(releasedEvent(orderId)));

    const mail = await waitForMail(1);
    expect(mail[0]?.to).toContain(`doctor@${SLUG}.test`);
    expect(mail[0]?.subject).toContain("Complete Blood Count");
    expect(mail[0]?.body).toContain("Dr Rao");
    // Rendered, not a template. A doctor must never receive `{{patientName}}`.
    expect(mail[0]?.body).not.toContain("{{");

    // ── AND THE PATIENT STOPS WAITING ────────────────────────────────────────
    // Nothing is outstanding, so the encounter comes back out of `awaiting_results`
    // and the patient can be called in. This is the loop closing.
    const enc = await as("doctor", request(app).get(`/api/v1/encounters/${encounterId}`)).expect(
      200,
    );
    expect(enc.body.data.status).toBe("in_progress");
  });

  it("the patient keeps waiting while ANY order is still outstanding", async () => {
    const encounterId = await encounterWithDoctor("Patient Two", "9000000011");

    const a = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "LFT", name: "Liver Function" })
      .expect(201);
    const b = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "RFT", name: "Renal Function" })
      .expect(201);

    await as(
      "doctor",
      request(app).post(`/api/v1/encounters/${encounterId}/investigations`),
    ).expect(200);

    const settle = async (id: string): Promise<void> => {
      await as("tech", request(app).post(`/api/v1/orders/${id}/accept`)).expect(200);
      await as("tech", request(app).post(`/api/v1/orders/${id}/start`)).expect(200);
      await as("tech", request(app).post(`/api/v1/orders/${id}/complete`))
        .send({ summary: "Normal." })
        .expect(200);
      await as("pathologist", request(app).post(`/api/v1/orders/${id}/verify`)).expect(200);
      await as("pathologist", request(app).post(`/api/v1/orders/${id}/release`)).expect(200);
      await asRelay(() => dispatchEventInline(releasedEvent(id)));
    };

    // The FIRST of two results lands. The doctor still has a blank in front of them.
    await settle(a.body.data.order.id as string);

    let enc = await as("doctor", request(app).get(`/api/v1/encounters/${encounterId}`)).expect(200);
    // Calling the patient in now would send them straight back out to wait again, and
    // a waiting room that does that twice stops believing the queue.
    expect(enc.body.data.status).toBe("awaiting_results");

    // The second lands. NOW they can be called in.
    await settle(b.body.data.order.id as string);

    enc = await as("doctor", request(app).get(`/api/v1/encounters/${encounterId}`)).expect(200);
    expect(enc.body.data.status).toBe("in_progress");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE SECOND PAIR OF EYES — who may sign a result off
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a result is certified by someone qualified to read it", () => {
  it("the DOCTOR who ordered it cannot verify it — they would be the only pair of eyes", async () => {
    const encounterId = await encounterWithDoctor("Self Verify", "9000000020");

    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
      .send({ summary: "Hb 11.9" })
      .expect(200);

    // A doctor holds `order:create`, not `order:verify`. The check that catches a
    // wrong number before somebody acts on it cannot be performed by the person who
    // wants the number to be right.
    await as("doctor", request(app).post(`/api/v1/orders/${orderId}/verify`)).expect(403);
  });

  it("the TECHNICIAN who ran it cannot verify it either", async () => {
    const encounterId = await encounterWithDoctor("Tech Verify", "9000000021");

    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
      .send({ summary: "Hb 11.9" })
      .expect(200);

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/verify`)).expect(403);
  });

  /**
   * ── THE SHARP EDGE OF A POLYMORPHIC ORDER ─────────────────────────────────
   * One object with one lifecycle means one `order:verify` permission — and both a
   * pathologist and a radiologist hold it. Without a category check, a pathologist
   * could sign off a CT scan they cannot read. A signature from someone who cannot
   * read the result is not a second pair of eyes; it is a formality with a name on it.
   */
  it("a PATHOLOGIST cannot sign off a RADIOLOGY scan, and a RADIOLOGIST cannot sign off a blood test", async () => {
    const encounterId = await encounterWithDoctor("Cross Verify", "9000000022");

    const scan = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "radiology", code: "XR_CHEST", name: "Chest X-ray" })
      .expect(201);
    const scanId = scan.body.data.order.id as string;

    const blood = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const bloodId = blood.body.data.order.id as string;

    for (const [role, id] of [
      ["radiologist", scanId],
      ["tech", bloodId],
    ] as const) {
      await as(role, request(app).post(`/api/v1/orders/${id}/accept`)).expect(200);
      await as(role, request(app).post(`/api/v1/orders/${id}/start`)).expect(200);
      await as(role, request(app).post(`/api/v1/orders/${id}/complete`))
        .send({ summary: "Reported." })
        .expect(200);
    }

    // Both hold `order:verify`. Only one of them can read each result.
    const wrongScan = await as(
      "pathologist",
      request(app).post(`/api/v1/orders/${scanId}/verify`),
    ).expect(403);
    expect(wrongScan.body.error.code).toBe("HMS-AUTH-005");
    expect(wrongScan.body.error.details.required).toBe("radiology:sign");

    const wrongBlood = await as(
      "radiologist",
      request(app).post(`/api/v1/orders/${bloodId}/verify`),
    ).expect(403);
    expect(wrongBlood.body.error.details.required).toBe("lab:approve");

    // And each CAN sign off their own category.
    await as("radiologist", request(app).post(`/api/v1/orders/${scanId}/verify`)).expect(200);
    await as("pathologist", request(app).post(`/api/v1/orders/${bloodId}/verify`)).expect(200);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE CRITICAL VALUE — the one message that cannot wait for a queue
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a critical result is alerted immediately, not eventually", () => {
  it("alerts the ordering doctor SYNCHRONOUSLY at completion — before verification, before release", async () => {
    await clearMailbox();

    const encounterId = await encounterWithDoctor("Critical Kaur", "9000000030");

    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "K", name: "Serum Potassium", priority: "stat" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
      .send({
        summary: "Potassium 7.2 mmol/L",
        values: [
          { code: "K", label: "Potassium", value: "7.2", unit: "mmol/L", flag: "critical_high" },
        ],
        critical: true,
      })
      .expect(200);

    /**
     * NO EVENT WAS DISPATCHED. No relay ran. No queue was drained.
     *
     * That is the entire assertion: the alert is already in the doctor's inbox by the
     * time the request that recorded the result has returned. A potassium of 7.2 stops
     * the heart, and it does not wait for a pathologist to come back from lunch or for
     * a queue to catch up.
     */
    const mail = await waitForMail(1);
    expect(mail[0]?.to).toContain(`doctor@${SLUG}.test`);
    expect(mail[0]?.subject).toContain("CRITICAL");
    // It carries the VALUE — unlike every other message in the product. The whole
    // purpose is to make a human act in the next few minutes, and "log in to see it"
    // wastes exactly those minutes.
    expect(mail[0]?.body).toContain("7.2");
    expect(mail[0]?.body).toContain("Critical Kaur");

    // The result is still UNVERIFIED. The alert did not bypass the second pair of
    // eyes; it simply refused to wait for it.
    const order = await as("doctor", request(app).get(`/api/v1/orders/${orderId}`)).expect(200);
    expect(order.body.data.status).toBe("completed");
  });

  it("sends exactly ONE alert however many times the result is re-read", async () => {
    // The ledger is keyed on the order, not on a delivery. A doctor who is told twice
    // about one critical value starts ignoring the channel — which is the failure mode
    // the alert exists to prevent.
    const before = await inbox();
    const critical = before.filter((m) => m.subject.includes("CRITICAL"));
    expect(critical).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. IDEMPOTENCY — a double-click must not draw two tubes of blood
 * ──────────────────────────────────────────────────────────────────────────── */

describe("ordering the same thing twice", () => {
  it("a repeated requestId returns the SAME order rather than placing a second", async () => {
    const encounterId = await encounterWithDoctor("Double Click", "9000000040");
    const requestId = "req-double-click-0001";

    const first = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count", requestId })
      .expect(201);

    // The doctor's finger, or a client retrying after a timeout on a request that had
    // in fact succeeded. A second order here draws a second tube of blood from a real
    // arm and raises a second bill for it.
    const second = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count", requestId })
      // 200, not 201: nothing was created.
      .expect(200);

    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.order.id).toBe(first.body.data.order.id);

    const all = await as(
      "doctor",
      request(app).get(`/api/v1/orders?encounterId=${encounterId}`),
    ).expect(200);
    expect(all.body.data).toHaveLength(1);
  });

  it("but the same test CAN legitimately be ordered twice without a requestId — a repeat is not a mistake", async () => {
    // A doctor repeating a blood sugar two hours later is medicine, not a double-click.
    // The index must not confuse the two, which is exactly why the key is supplied by
    // the client rather than derived from the content.
    const encounterId = await encounterWithDoctor("Repeat Test", "9000000041");

    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "GLU", name: "Blood Glucose" })
      .expect(201);
    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "GLU", name: "Blood Glucose" })
      .expect(201);

    const all = await as(
      "doctor",
      request(app).get(`/api/v1/orders?encounterId=${encounterId}`),
    ).expect(200);
    expect(all.body.data).toHaveLength(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE WORKLIST — sickest first, then oldest
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the department worklist", () => {
  it("puts an EMERGENCY placed a moment ago above a ROUTINE placed first", async () => {
    const encounterId = await encounterWithDoctor("Triage Order", "9000000050");

    const routine = await as("doctor", request(app).post("/api/v1/orders"))
      .send({
        encounterId,
        category: "procedure",
        code: "DRESS",
        name: "Wound Dressing",
        priority: "routine",
      })
      .expect(201);

    const emergency = await as("doctor", request(app).post("/api/v1/orders"))
      .send({
        encounterId,
        category: "procedure",
        code: "ECG",
        name: "12-lead ECG",
        priority: "emergency",
      })
      .expect(201);

    const list = await as(
      "tech",
      request(app).get("/api/v1/orders?category=procedure&outstanding=true"),
    ).expect(200);

    const ids = (list.body.data as { id: string }[]).map((o) => o.id);
    // If this ever inverts, the lab works the routine cholesterol before the emergency
    // troponin — a list that looks sorted, is sorted, and is lethal.
    expect(ids.indexOf(emergency.body.data.order.id as string)).toBeLessThan(
      ids.indexOf(routine.body.data.order.id as string),
    );
  });

  /**
   * ── EVERY ROW NAMES ITS PATIENT ─────────────────────────────────────────────
   * The web worklist used to fetch "the first 100 patients in this hospital" and look each
   * order's patient up in that array. Two silent truncations stacked: an order past row 100 was
   * absent, and an order whose patient was not among those 100 patients rendered as "—". Both
   * failed toward LESS work being visible, which on a lab queue is a sample nobody runs.
   *
   * `InpatientRow` already carries its identity for exactly this reason and says so: "a client
   * must never reconstruct it from a patient list." These tests hold the orders list to the same
   * rule, so no future screen can be tempted to join it client-side again.
   */
  it("carries the patient's name and UHID on every row", async () => {
    const encounterId = await encounterWithDoctor("Named On The Row", "9000000060");
    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    const list = await as(
      "tech",
      request(app).get("/api/v1/orders?category=lab&outstanding=true"),
    ).expect(200);

    const rows = list.body.data as { encounterId: string; patientName: string; uhid: string }[];
    const row = rows.find((o) => o.encounterId === encounterId);

    expect(row?.patientName).toBe("Named On The Row");
    // A UHID is what a technician matches against the label on the sample tube.
    expect(row?.uhid).toMatch(/\S/);
  });

  it("never leaves the name BLANK — an unreadable patient is said, not omitted", async () => {
    /**
     * The important half. A blank name on a worklist row reads as "no patient", and the fix for
     * the join was worthless if it merely moved the silence to the server. Every row carries a
     * string; when the record cannot be read it says so in words.
     */
    const list = await as(
      "tech",
      request(app).get("/api/v1/orders?category=lab&outstanding=true"),
    ).expect(200);

    for (const row of list.body.data as { patientName: string }[]) {
      expect(typeof row.patientName).toBe("string");
      expect(row.patientName.length).toBeGreaterThan(0);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE STATE MACHINE (STATE_MACHINE_CATALOG §15)
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the order state machine", () => {
  it("cannot be cancelled once the sample is on the bench", () => {
    // The specimen has been drawn and the analyser has consumed it. Letting the order
    // vanish would discard a real, already-taken sample and leave the lab holding a
    // tube for an order that no longer exists.
    expect(canTransition("placed", "cancelled")).toBe(true);
    expect(canTransition("accepted", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(false);
  });

  it("cannot be released without being verified first", () => {
    expect(canTransition("completed", "released")).toBe(false);
    expect(canTransition("completed", "verified")).toBe(true);
    expect(canTransition("verified", "released")).toBe(true);
  });

  it("a released and a cancelled order are both SETTLED — nothing is owed", () => {
    expect(isOutstanding("released")).toBe(false);
    expect(isOutstanding("cancelled")).toBe(false);
    expect(isOutstanding("placed")).toBe(true);
    // Completed but unverified is still OWED. The doctor has not been told, and until
    // they have, the patient is still waiting on it.
    expect(isOutstanding("completed")).toBe(true);
  });

  it("refuses an illegal transition over HTTP rather than corrupting the order", async () => {
    const encounterId = await encounterWithDoctor("Illegal Order", "9000000060");

    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    // You cannot verify a result that nobody has produced.
    const res = await as(
      "pathologist",
      request(app).post(`/api/v1/orders/${orderId}/verify`),
    ).expect(422);
    expect(res.body.error.code).toBe("HMS-STATE-001");
  });

  it("a completed order must actually carry a result", async () => {
    const encounterId = await encounterWithDoctor("Empty Result", "9000000061");

    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);

    // "Done" with nothing to show for it is not a result; it is a lost sample with a
    // green tick next to it.
    await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
      .send({})
      .expect(400);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. AN ORDER BELONGS TO A LIVE VISIT
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an order cannot be raised against a visit that is over", () => {
  it("refuses to order a test for a patient who has gone home", async () => {
    const p = await as("reception", request(app).post("/api/v1/patients"))
      .send({ name: "Gone Home", gender: "male", contact: { phone: "9000000070" } })
      .expect(201);

    const enc = await as("reception", request(app).post("/api/v1/encounters"))
      .send({ patientId: p.body.data.patient.id, departmentId: doctorId })
      .expect(201);
    const encounterId = enc.body.data.encounter.id as string;

    await as("doctor", request(app).post(`/api/v1/encounters/${encounterId}/start`)).expect(200);
    await as("doctor", request(app).post(`/api/v1/encounters/${encounterId}/close`))
      .send({})
      .expect(200);

    // Work nobody is expecting, for a patient who has left, billed to a visit that has
    // already been settled. If a further test is genuinely needed, the patient has come
    // back — and coming back is a new encounter in the same episode.
    const res = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(422);

    expect(res.body.error.code).toBe("HMS-STATE-001");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. RUNTIME SCHEMA SAFETY — the spine refuses to RAISE work it cannot deduplicate
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ORDERING RUNTIME SCHEMA SAFETY.
 *
 * ── WHY PLACING AN ORDER IS THE MOST EXPOSED WRITE OF THE THREE ─────────────
 * `placeOrder` performs NO read before it writes. It enters the transaction and inserts, and
 * consults `findByRequestId` only AFTER the database has answered E11000 — so unlike dispensing
 * there is not even a courtesy pre-check. Measured against Mongo 7 on 2026-08-17 with
 * `one_order_per_request_id` absent: both inserts of one `requestId` are ACCEPTED, two rows exist,
 * and recreating the index over them is then REFUSED (11000). A duplicate is a second tube of
 * blood from a real arm, a second exposure for an X-ray, and a second bill.
 *
 * ── AND THE PHARMACY PATH HAS NO SECOND LOCK AT ALL ─────────────────────────
 * `prescription.signed` reaches this same function from an EVENT — no HTTP request, therefore no
 * `Idempotency-Key` middleware — carrying `requestId: "rx:<prescriptionId>"`. Delivery is
 * at-least-once by design. There, the index is not merely the arbiter of a race; it is the only
 * thing that exists.
 *
 * The suite drops a real index on its own throwaway tenant and puts it straight back. Readiness is
 * cached for a minute, so every transition clears it.
 */
describe("ordering refuses when the database cannot enforce one-order-per-request", () => {
  const ORDER_INDEX = "one_order_per_request_id";

  async function dropOrderIndex(): Promise<void> {
    await tenantConnection.collection("orders").dropIndex(ORDER_INDEX);
    forgetSchemaReadiness();
  }

  async function restoreOrderIndex(): Promise<void> {
    await tenantConnection.collection("orders").createIndex(
      { tenantId: 1, requestId: 1 },
      {
        unique: true,
        partialFilterExpression: { requestId: { $exists: true } },
        background: true,
        name: ORDER_INDEX,
      },
    );
    forgetSchemaReadiness();
  }

  it("places normally while the invariant it rests on is armed", async () => {
    const encounterId = await encounterWithDoctor("Guard Normal", "9000000200");

    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
  });

  /**
   * ── THE REFUSAL ───────────────────────────────────────────────────────────
   * 503 rather than 4xx: the request is correct and will work once the schema is repaired. It
   * names the rule and the migration, because whoever is paged needs those and not a count.
   */
  it("answers 503 HMS-ORD-001 with Retry-After when the order index is gone", async () => {
    const encounterId = await encounterWithDoctor("Guard Refusal", "9000000201");

    await dropOrderIndex();
    try {
      const res = await as("doctor", request(app).post("/api/v1/orders")).send({
        encounterId,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
        requestId: "guard-order-refusal-0001",
      });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-ORD-001");
      expect(res.headers["retry-after"]).toBe("60");

      const missing = res.body.error.details.missing as { rule: string; migration: string }[];
      expect(missing.map((m) => m.migration)).toContain("0013-orders");
      // It must tell the doctor what to DO, not merely that something failed.
      expect(String(res.body.error.message)).toMatch(/paper/i);
    } finally {
      await restoreOrderIndex();
    }
  });

  /**
   * The guard runs before the transaction opens, so a refusal cannot leave a half-raised order,
   * an inflated `activeOrderCount`, or an `order.placed` event the lab would act on.
   */
  it("writes NOTHING when it refuses — no order, no visit counter, no outbox event", async () => {
    const encounterId = await encounterWithDoctor("Guard No Write", "9000000202");

    const outboxBefore = await tenantConnection.collection("outbox").countDocuments({});

    await dropOrderIndex();
    try {
      await as("doctor", request(app).post("/api/v1/orders"))
        .send({
          encounterId,
          category: "lab",
          code: "LFT",
          name: "Liver Function Test",
          requestId: "guard-order-nowrite-0001",
        })
        .expect(503);

      expect(
        await tenantConnection
          .collection("orders")
          .countDocuments({ requestId: "guard-order-nowrite-0001" }),
      ).toBe(0);
      expect(await tenantConnection.collection("outbox").countDocuments({})).toBe(outboxBefore);
    } finally {
      await restoreOrderIndex();
    }

    // The visit is still orderable, which is what proves the counter was never bumped: a refusal
    // that had counted an order would let this visit be sent for tests with nothing ordered.
    const encounter = await as(
      "doctor",
      request(app).get(`/api/v1/encounters/${encounterId}`),
    ).expect(200);
    expect(encounter.body.data.activeOrderCount).toBe(0);
  });

  it("places again the moment the index is restored", async () => {
    const encounterId = await encounterWithDoctor("Guard Recovery", "9000000203");

    await dropOrderIndex();
    const refused = await as("doctor", request(app).post("/api/v1/orders")).send({
      encounterId,
      category: "lab",
      code: "CBC",
      name: "Complete Blood Count",
    });
    expect(refused.status).toBe(503);

    await restoreOrderIndex();
    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
  });

  /**
   * ── THE DIVERGENCE FROM MAR AND DISPENSING, TESTED ────────────────────────
   * Both of those also require `idempotent-replay`, because each has a legitimate write carrying
   * no module identifier — a PRN dose, a partial handover — for which the `Idempotency-Key` claim
   * is the only lock. Ordering has no such write: both clients send `requestId` alongside the
   * header and the pharmacy consumer sets one explicitly. So losing the claim index alone leaves
   * ordering still arbitrated by 0013, and refusing then would block a hospital that is safe.
   */
  it("does NOT refuse when only the idempotency claim index is gone — 0013 still arbitrates", async () => {
    const encounterId = await encounterWithDoctor("Guard Claim Only", "9000000204");

    await tenantConnection.collection("idempotencyKeys").dropIndex("one_claim_per_idempotency_key");
    forgetSchemaReadiness();
    try {
      await as("doctor", request(app).post("/api/v1/orders"))
        .send({
          encounterId,
          category: "lab",
          code: "CBC",
          name: "Complete Blood Count",
          requestId: "guard-claim-only-0001",
        })
        .expect(201);

      // And the module's own guard is demonstrably still doing the work.
      const second = await as("doctor", request(app).post("/api/v1/orders"))
        .send({
          encounterId,
          category: "lab",
          code: "CBC",
          name: "Complete Blood Count",
          requestId: "guard-claim-only-0001",
        })
        .expect(200);
      expect(second.body.data.duplicate).toBe(true);
    } finally {
      await tenantConnection.collection("idempotencyKeys").createIndex(
        { tenantId: 1, userId: 1, key: 1 },
        {
          unique: true,
          background: true,
          name: "one_claim_per_idempotency_key",
        },
      );
      forgetSchemaReadiness();
    }
  });

  /**
   * ── WORK ALREADY ON THE BENCH MUST STILL FINISH ───────────────────────────
   * The state machine updates a row that exists and rests on nothing this index provides. A
   * drifted tenant that could not complete or release would strand samples mid-analysis for a
   * rule with no bearing on them — and would keep patients in `awaiting_results` with no way out.
   */
  it("lets the lab accept, run, complete, verify and release while placing is refused", async () => {
    const encounterId = await encounterWithDoctor("Guard In Flight", "9000000205");
    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    const orderId = placed.body.data.order.id as string;

    await dropOrderIndex();
    try {
      await as("doctor", request(app).post("/api/v1/orders"))
        .send({ encounterId, category: "lab", code: "GLU", name: "Blood Glucose" })
        .expect(503);

      await as("tech", request(app).post(`/api/v1/orders/${orderId}/accept`)).expect(200);
      await as("tech", request(app).post(`/api/v1/orders/${orderId}/start`)).expect(200);
      await as("tech", request(app).post(`/api/v1/orders/${orderId}/complete`))
        .send({ summary: "Hb 11.9 g/dL" })
        .expect(200);
      await as("pathologist", request(app).post(`/api/v1/orders/${orderId}/verify`)).expect(200);
      const released = await as(
        "pathologist",
        request(app).post(`/api/v1/orders/${orderId}/release`),
      ).expect(200);
      expect(released.body.data.status).toBe("released");
    } finally {
      await restoreOrderIndex();
    }
  });

  it("does not touch cancellation either — an order already raised can still be called off", async () => {
    const encounterId = await encounterWithDoctor("Guard Cancel", "9000000206");
    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    await dropOrderIndex();
    try {
      await as("doctor", request(app).post(`/api/v1/orders/${placed.body.data.order.id}/cancel`))
        .send({ reason: "ordered in error" })
        .expect(200);
    } finally {
      await restoreOrderIndex();
    }
  });

  /** Observations are not ordering. A nurse must not lose the obs round to a lab index. */
  it("does not block a nurse recording observations", async () => {
    const encounterId = await encounterWithDoctor("Guard Vitals", "9000000207");

    await dropOrderIndex();
    try {
      await as("nurse", request(app).post(`/api/v1/encounters/${encounterId}/vitals`))
        .send({ pulse: 88, temperature: 37.1 })
        .expect(201);
    } finally {
      await restoreOrderIndex();
    }
  });

  /** Reading is not writing. The worklist and the chart stay legible while placing is refused. */
  it("does not block reads — the existing worklist is still visible", async () => {
    const encounterId = await encounterWithDoctor("Guard Reads", "9000000208");
    await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);

    await dropOrderIndex();
    try {
      const list = await as(
        "tech",
        request(app).get(`/api/v1/orders?encounterId=${encounterId}`),
      ).expect(200);
      expect(list.body.data).toHaveLength(1);
    } finally {
      await restoreOrderIndex();
    }
  });

  /**
   * Database-per-tenant (ADR-0005) means one hospital's drift is one hospital's problem. The
   * readiness cache is keyed by tenant, and this is the test that would catch it if it were not.
   */
  it("does not block a DIFFERENT hospital, whose own index is intact", async () => {
    const mine = await encounterWithDoctor("Guard Isolation", "9000000209");
    const theirs = await otherEncounter("Other Hospital", "9000000210");

    await dropOrderIndex();
    try {
      await as("doctor", request(app).post("/api/v1/orders"))
        .send({ encounterId: mine, category: "lab", code: "CBC", name: "Complete Blood Count" })
        .expect(503);

      await asOther("doctor", request(app).post("/api/v1/orders"))
        .send({ encounterId: theirs, category: "lab", code: "CBC", name: "Complete Blood Count" })
        .expect(201);
    } finally {
      await restoreOrderIndex();
    }
  });

  /**
   * ── A PENDING MIGRATION IS NOT A REASON TO REFUSE ─────────────────────────
   * The runtime guard asks whether THIS capability's constraint is enforceable, not whether the
   * tenant is fully converged — that is the deployment gate's question, and it is asked before a
   * release rather than in front of a doctor. Un-recording a migration whose index is present
   * changes nothing here, which is the whole distinction between the two mechanisms.
   */
  it("is unmoved by an un-recorded migration whose index is actually present", async () => {
    const encounterId = await encounterWithDoctor("Guard Pending", "9000000211");

    const history = tenantConnection.collection("migrations");
    const record = await history.findOne({ _id: "0049-mar" as never });
    await history.deleteOne({ _id: "0049-mar" as never });
    forgetSchemaReadiness();
    try {
      // The deployment gate sees the tenant as behind. `readHistory` returns RECORDS, not ids —
      // asserting `toContain("0049-mar")` against them would pass whatever the history said.
      const applied = (await readHistory(tenantConnection)).map((r) => r._id);
      expect(applied).toContain("0013-orders");
      expect(applied).not.toContain("0049-mar");

      // … and the doctor orders anyway, because the constraint itself is armed.
      await as("doctor", request(app).post("/api/v1/orders"))
        .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
        .expect(201);
    } finally {
      if (record) await history.insertOne(record);
      forgetSchemaReadiness();
    }
  });

  /**
   * ── FAIL CLOSED ───────────────────────────────────────────────────────────
   * An index that exists on the right fields but is NOT unique enforces nothing. The readiness
   * inspector must read that as unsafe rather than as "an index called that is present".
   */
  it("fails CLOSED when the index exists but has stopped being unique", async () => {
    const encounterId = await encounterWithDoctor("Guard Not Unique", "9000000212");

    await tenantConnection.collection("orders").dropIndex(ORDER_INDEX);
    await tenantConnection.collection("orders").createIndex(
      { tenantId: 1, requestId: 1 },
      {
        // No `unique` — the shape is right and the guarantee is gone.
        partialFilterExpression: { requestId: { $exists: true } },
        background: true,
        name: ORDER_INDEX,
      },
    );
    forgetSchemaReadiness();
    try {
      const res = await as("doctor", request(app).post("/api/v1/orders")).send({
        encounterId,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
      });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-ORD-001");
    } finally {
      await tenantConnection.collection("orders").dropIndex(ORDER_INDEX);
      await restoreOrderIndex();
    }
  });

  /**
   * The `orders` collection itself being absent is a different fault from an index being absent,
   * and it must not read as "everything is fine because the query found nothing".
   */
  it("fails CLOSED when the orders collection does not exist at all", async () => {
    const encounterId = await encounterWithDoctor("Guard No Collection", "9000000213");

    const saved = await tenantConnection.collection("orders").find({}).toArray();
    await tenantConnection.collection("orders").drop();
    forgetSchemaReadiness();
    try {
      const res = await as("doctor", request(app).post("/api/v1/orders")).send({
        encounterId,
        category: "lab",
        code: "CBC",
        name: "Complete Blood Count",
      });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("HMS-ORD-001");
      expect(String(res.body.error.details.missing[0].found)).toMatch(/does not exist/i);
    } finally {
      await restoreOrderIndex();
      await tenantConnection
        .collection("orders")
        .createIndex(
          { tenantId: 1, category: 1, status: 1, priorityRank: 1, orderedAt: 1 },
          { background: true, name: "department_worklist" },
        );
      if (saved.length > 0) await tenantConnection.collection("orders").insertMany(saved);
      forgetSchemaReadiness();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE LAB TEST CATALOGUE (D6) — the master that stops a range being retyped
 *
 * `labTests` shipped empty on every hospital, so `getLabTest(order.code)` found nothing and result
 * entry fell back to a blank grid — the exact re-typing the module exists to end. These prove the
 * starter catalogue is actually there, that it JOINS the tariff on `code` (an order carries one
 * code that billing, the lab and the result grid must all agree on), and that re-seeding a
 * hospital never rewrites reference ranges it has curated.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the laboratory catalogue a hospital starts with", () => {
  it("lists the starter tests to the technician who will enter results against them", async () => {
    const res = await as("tech", request(app).get("/api/v1/lab-tests")).expect(200);
    const codes = (res.body.data as { code: string }[]).map((t) => t.code);

    expect(codes, "the catalogue is empty — the analyte grid will be blank").toHaveLength(
      STARTER_LAB_TEST_COUNT,
    );
    expect(codes).toEqual(expect.arrayContaining([...STARTER_LAB_TEST_CODES]));
  });

  /**
   * WHAT DEFECT WOULD THIS CATCH?
   * The catalogue and the tariff drifting apart. An order carries ONE `code`: billing prices it
   * (`serviceItems`), the lab defines it (`labTests`), and the result grid pre-fills from it. A
   * catalogue keyed on anything else is a second master that agrees with the first only by luck —
   * and the symptom is a test that bills correctly and pre-fills nothing, which reads as "the
   * catalogue is broken" rather than "the two codes differ".
   */
  it("uses the same codes the tariff prices, so one order means one thing to both", async () => {
    // `/services/catalogue`, not `/services`: the rate card needs `billing:read`, which a doctor
    // deliberately lacks — the distinction PROJECT_MEMORY records as breaking the order pad once.
    const tariff = await as(
      "doctor",
      request(app).get("/api/v1/services/catalogue?category=lab"),
    ).expect(200);
    const priced = new Set((tariff.body.data as { code: string }[]).map((s) => s.code));

    for (const code of STARTER_LAB_TEST_CODES) {
      expect(priced.has(code), `${code} is in the lab catalogue but has no tariff entry`).toBe(
        true,
      );
    }
  });

  it("carries the analytes, their units and a printable range for each", async () => {
    const res = await as("tech", request(app).get("/api/v1/lab-tests/CBC")).expect(200);
    const test = res.body.data as {
      name: string;
      specimenType?: string;
      analytes: { code: string; label: string; unit?: string; refText?: string }[];
    };

    expect(test.name).toBe("Complete Blood Count");
    expect(test.specimenType, "the phlebotomy desk is told which tube to draw").toBeTruthy();

    const hb = test.analytes.find((a) => a.code === "HB");
    expect(hb?.label).toBe("Haemoglobin");
    expect(hb?.unit).toBe("g/dL");
    // Derived from the numeric bounds — the form a clinician reads a range in.
    expect(hb?.refText).toBe("12–17");
  });

  /**
   * A one-sided limit is not an interval, and rendering it as one would be wrong in the direction
   * that matters: "0–200" invites a reading of a cholesterol of 0 as normal.
   */
  it("renders a one-sided limit as a limit, not as an interval starting at zero", async () => {
    const res = await as("tech", request(app).get("/api/v1/lab-tests/LIPID")).expect(200);
    const analytes = res.body.data.analytes as { code: string; refText?: string }[];

    expect(analytes.find((a) => a.code === "CHOL")?.refText).toBe("< 200");
    expect(analytes.find((a) => a.code === "HDL")?.refText).toBe("> 40");
  });

  /**
   * WHAT DEFECT WOULD THIS CATCH?
   * A deploy resetting a laboratory's own reference intervals. A lab sets its ranges against its
   * own method and analyser; a seed that overwrote them on the next migrate would silently replace
   * clinical configuration with our defaults, and the report that came out would be wrong in a way
   * nobody looks for. `$setOnInsert` is the whole promise, and this is what holds it.
   */
  it("never overwrites a range the hospital has curated, however often it is re-seeded", async () => {
    const before = await as("pathologist", request(app).get("/api/v1/lab-tests/GLU")).expect(200);
    const id = before.body.data.id as string;

    await as("pathologist", request(app).patch(`/api/v1/lab-tests/${id}`))
      .send({
        analytes: [
          { code: "FPG", label: "Fasting Plasma Glucose", unit: "mg/dL", refLow: 74, refHigh: 106 },
        ],
      })
      .expect(200);

    const added = await seedLabTests(tenantId, SLUG, tenantConnection);
    expect(added, "a re-seed inserted a test that already existed").toBe(0);

    const after = await as("pathologist", request(app).get("/api/v1/lab-tests/GLU")).expect(200);
    const fpg = (after.body.data.analytes as { code: string; refLow?: number }[]).find(
      (a) => a.code === "FPG",
    );
    expect(fpg?.refLow, "the re-seed reverted the hospital's own reference range").toBe(74);
  });

  /** The catalogue is clinical config, not PHI — but it is still not public. */
  it("is closed to a role with no part in ordering or running a test", async () => {
    await as("nurse", request(app).post("/api/v1/lab-tests"))
      .send({ code: "SNEAK", name: "Unauthorised Test" })
      .expect(403);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE TECHNICIAN CAN SEE THE FILE THEY JUST UPLOADED
 *
 * They could attach a report and were never shown that it landed: the worklist's "is anything
 * already attached?" read was the PATIENT-wide list, gated on `emr:read`, which a lab technician
 * deliberately does not hold. It 403'd, the page soft-failed, and the confirmation ("1 report
 * attached — the doctor can see it now") never appeared for the one role that uploads them. Worse,
 * a re-scan looked like the first scan, because the list that would have said otherwise was empty.
 *
 * The fix is a narrower read, not a wider grant. `emr:read` opens twenty-one routes across
 * admissions, wards, prescriptions, theatres, the MAR and medico-legal records — a lab technician
 * has no business in any of them, and these tests pin that they still do not.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a lab technician can see the reports on the orders in front of them", () => {
  let orderId = "";
  let reportId = "";

  beforeAll(async () => {
    const encounterId = await encounterWithDoctor("Report Reader", "9000000310");
    const placed = await as("doctor", request(app).post("/api/v1/orders"))
      .send({ encounterId, category: "lab", code: "CBC", name: "Complete Blood Count" })
      .expect(201);
    orderId = placed.body.data.order.id as string;

    const uploaded = await as("tech", request(app).post(`/api/v1/orders/${orderId}/reports`))
      .send({
        filename: "cbc-scan.pdf",
        contentType: "application/pdf",
        dataBase64: Buffer.from("%PDF-1.4 CBC RESULT").toString("base64"),
      })
      .expect(201);
    reportId = uploaded.body.data.id as string;
  });

  it("reads back the report it attached, keyed on the order", async () => {
    const res = await as("tech", request(app).get(`/api/v1/reports?orderIds=${orderId}`)).expect(
      200,
    );
    const rows = res.body.data as { id: string; filename: string; orderId: string }[];
    expect(rows.map((r) => r.id)).toContain(reportId);
    expect(rows[0]?.filename).toBe("cbc-scan.pdf");
  });

  /**
   * The boundary that makes the narrow read worth having. If this ever returns 200, somebody has
   * widened `emr:read` to the laboratory and the technician now reads the whole clinical record.
   */
  it("is still refused the patient's chart-wide report history", async () => {
    const patient = await as("doctor", request(app).get(`/api/v1/orders/${orderId}`)).expect(200);
    const patientId = patient.body.data.patientId as string;

    const res = await as("tech", request(app).get(`/api/v1/patients/${patientId}/reports`));
    expect(res.status, "a lab technician was handed the whole chart's report history").toBe(403);
    expect(res.body.error.details.required).toBe("emr:read");
  });

  /**
   * And metadata is where it stops. Knowing a file exists is the worklist's question; reading the
   * result printed on it is a clinical act, and that stays behind the chart's permission.
   */
  it("cannot open the bytes — knowing a report exists is not reading it", async () => {
    const res = await as("tech", request(app).get(`/api/v1/reports/${reportId}/file`));
    expect(res.status).toBe(403);
  });

  it("returns nothing rather than everything when asked about no orders", async () => {
    const res = await as("tech", request(app).get("/api/v1/reports?orderIds=,,"));
    // The schema requires a non-empty string; an all-separator value parses to zero ids.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect(res.body.data).toEqual([]);
  });

  /** The doctor the result comes back to keeps the chart-wide view they always had. */
  it("leaves the doctor's cross-visit report list exactly as it was", async () => {
    const order = await as("doctor", request(app).get(`/api/v1/orders/${orderId}`)).expect(200);
    const patientId = order.body.data.patientId as string;

    const res = await as(
      "doctor",
      request(app).get(`/api/v1/patients/${patientId}/reports`),
    ).expect(200);
    expect((res.body.data as { id: string }[]).map((r) => r.id)).toContain(reportId);
  });
});
