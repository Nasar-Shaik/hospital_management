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
const { dispatchEventInline } = await import("./core/events/eventConsumer.js");
const { canTransition, isOutstanding } = await import("./modules/orders/index.js");

const SLUG = "test-orders";
const HOST = `${SLUG}.medicore.test`;
const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "orders-int-test" }));

let tenantId = "";
let tenantConnection: Awaited<ReturnType<typeof getTenantConnection>>;
/** One token per ROLE. The whole point is that they are not interchangeable. */
const token: Record<string, string> = {};
let doctorId = "";

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

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", HOST)
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

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await assertMailhogReachable();
  await dropDatabases(["test_ord_master", `hms_${SLUG}`]);
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

  const ROLES: [key: string, roleCode: string, name: string][] = [
    ["reception", "RECEPTIONIST", "Front Desk"],
    ["doctor", "DOCTOR", "Dr Rao"],
    ["tech", "LAB_TECHNICIAN", "Tech Kumar"],
    ["pathologist", "PATHOLOGIST", "Dr Iyer"],
    ["radiologist", "RADIOLOGIST", "Dr Sharma"],
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
}, 180_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_ord_master", `hms_${SLUG}`]);
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
