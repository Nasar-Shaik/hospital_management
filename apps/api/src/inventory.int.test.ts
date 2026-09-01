/**
 * GENERAL STORE — release-gating (Modules G1/G3, General Stores v1).
 *
 * ── THE FIVE CLAIMS ─────────────────────────────────────────────────────────
 *
 *   1. THE SHELF NEVER GOES NEGATIVE. This is the module's whole reason to be stricter than the
 *      pharmacy, so it is tested at the boundary (issuing exactly what is there is legal; one
 *      more is not), under CONCURRENCY (two store keepers reaching for the last box), and in both
 *      directions (an over-issue and an over-write-off), with the balance re-read afterwards to
 *      prove a refusal moved nothing.
 *
 *   2. THE LEDGER RECONCILES. `onHand` equals the sum of every delta, and each movement's
 *      `balanceAfter` is the running total at that moment. A stock system whose history cannot
 *      reproduce its own number is a number nobody can defend.
 *
 *   3. THE SHELF BELONGS TO A SITE. A delivery booked at one branch does not appear at the other,
 *      an issue at the empty site is refused while the same item is in stock next door, and the
 *      aggregate view sums only what the caller may reach.
 *
 *   4. STOCK THAT LEAVES ARRIVES SOMEWHERE NAMEABLE. An unknown department or supplier is refused
 *      BEFORE anything moves — a ledger that balances while the goods are lost is worse than a
 *      refusal.
 *
 *   5. THE BOUNDARIES HOLD. Another hospital's item, a hospital that never bought the module, and
 *      a replayed submission are all handled by the SERVER.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("inventory");
process.env.MONGO_MASTER_DB = "test_inventory_master";
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

const SLUG = "test-inventory";
const RIVAL_SLUG = "test-inventory-rival";
const CLINIC_SLUG = "test-inventory-clinic";
const DB = `hms_${SLUG}`;
const RIVAL_DB = `hms_${RIVAL_SLUG}`;
const CLINIC_DB = `hms_${CLINIC_SLUG}`;
const PASSWORD = "V4lid!Password#2026";

const app = await listening(createApp(createLogger({ service: "inventory-int-test" })));

interface Site {
  id: string;
  slug: string;
  host: string;
  admin: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

const main = {} as Site;
const rival = {} as Site;
const clinic = {} as Site;

/** Holds all five store permissions and nothing clinical. */
let keeperToken = "";
/** A store keeper bound to the SECOND site only. */
let keeperBToken = "";
/** Holds `emr:read` and no store permission — the "cannot touch the shelf" probe. */
let nurseToken = "";

let siteA = "";
let siteB = "";
let deptWard = "";
let supplierId = "";
let rivalItem = "";

/** A well-formed id that belongs to nobody. */
const FORGED = "64b7f0000000000000000009";

function req(
  method: "get" | "post" | "patch",
  path: string,
  token: string,
  host: string,
  activeBranch?: string,
): request.Test {
  const r = request(app)[method](path).set("Host", host).set("Authorization", `Bearer ${token}`);
  return activeBranch ? r.set("X-Active-Branch", activeBranch) : r;
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${res.text}`);
  return res.body.data.accessToken as string;
}

async function makeUser(email: string, name: string, role: string, branchIds: string[]) {
  const u = await createUser({ email, name, status: "invited" });
  await setPassword(u.id, PASSWORD, { mustChangePassword: false });
  await assignRoleByCode(u.id, role, branchIds);
  await transitionStatus(u.id, "active");
  return u.id;
}

/** A fresh item, so no test depends on what another left on the shelf. */
let itemSeq = 0;
async function newItem(reorderLevel = 0): Promise<string> {
  itemSeq += 1;
  const res = await req("post", "/api/v1/inventory-items", keeperToken, main.host, siteA)
    .send({
      code: `ITEM${itemSeq}`,
      name: `Test item ${itemSeq}`,
      category: "consumable",
      unit: "box",
      reorderLevel,
    })
    .expect(201);
  return res.body.data.id as string;
}

/** The on-hand this call sees, from the list — the same number a screen would render. */
async function onHand(itemId: string, token = keeperToken, branch = siteA): Promise<number> {
  const res = await req("get", "/api/v1/inventory-items", token, main.host, branch).expect(200);
  const row = (res.body.data as { id: string; onHand: number }[]).find((r) => r.id === itemId);
  return row?.onHand ?? 0;
}

const receive = (itemId: string, body: Record<string, unknown>, branch = siteA, key?: string) => {
  const r = req(
    "post",
    `/api/v1/inventory-items/${itemId}/receive`,
    keeperToken,
    main.host,
    branch,
  );
  return (key ? r.set("Idempotency-Key", key) : r).send(body);
};
const issue = (
  itemId: string,
  body: Record<string, unknown>,
  branch = siteA,
  token = keeperToken,
) => req("post", `/api/v1/inventory-items/${itemId}/issue`, token, main.host, branch).send(body);
const adjust = (itemId: string, body: Record<string, unknown>, branch = siteA) =>
  req("post", `/api/v1/inventory-items/${itemId}/adjust`, keeperToken, main.host, branch).send(
    body,
  );

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases([process.env.MONGO_MASTER_DB as string, DB, RIVAL_DB, CLINIC_DB]);
  await flushTestCache("inventory");

  for (const [site, slug, plan, branches] of [
    [main, SLUG, "PLAN_HOSPITAL", 2],
    [rival, RIVAL_SLUG, "PLAN_HOSPITAL", 1],
    // No store flag in this edition — the entitlement probe.
    [clinic, CLINIC_SLUG, "PLAN_CLINIC", 1],
  ] as [Site, string, string, number][]) {
    const t = await provisionTenant({
      hospitalName: slug,
      slug,
      planCode: plan,
      organizationType: "private_hospital",
      maxBranches: branches,
    });
    site.id = t.tenant.id;
    site.slug = slug;
    site.host = `${slug}.medicore.test`;
    site.connection = await getTenantConnection({
      id: t.tenant.id,
      databaseName: t.tenant.databaseName,
    });
    await runWithContext(
      {
        traceId: `setup-${slug}`,
        tenantId: site.id,
        tenantSlug: slug,
        connection: site.connection,
      },
      async () => {
        await seedRbac();
        await makeUser(`admin@${slug}.test`, "Admin", "TENANT_ADMIN", []);
      },
    );
    site.admin = await login(site.host, `admin@${slug}.test`);
  }

  // Branches before any branch-bound staff exist.
  const branches = await req("get", "/api/v1/branches", main.admin, main.host).expect(200);
  siteA = (branches.body.data as { id: string }[])[0]!.id;
  siteB = (
    await req("post", "/api/v1/branches", main.admin, main.host)
      .send({ name: "Riverside", code: "RIV" })
      .expect(201)
  ).body.data.id as string;

  await runWithContext(
    { traceId: "setup-staff", tenantId: main.id, tenantSlug: SLUG, connection: main.connection },
    async () => {
      await makeUser(`keeper@${SLUG}.test`, "Mr Bose", "STORE_KEEPER", [siteA, siteB]);
      await makeUser(`keeperb@${SLUG}.test`, "Ms Nair", "STORE_KEEPER", [siteB]);
      await makeUser(`nurse@${SLUG}.test`, "Sister Fatima", "NURSE", [siteA]);
    },
  );
  keeperToken = await login(main.host, `keeper@${SLUG}.test`);
  keeperBToken = await login(main.host, `keeperb@${SLUG}.test`);
  nurseToken = await login(main.host, `nurse@${SLUG}.test`);

  deptWard = (
    await req("post", "/api/v1/departments", main.admin, main.host)
      .send({ name: "General Ward", code: "GW", kind: "clinical" })
      .expect(201)
  ).body.data.id as string;

  supplierId = (
    await req("post", "/api/v1/suppliers", keeperToken, main.host, siteA)
      .send({ code: "ACME", name: "Acme Surgical", phone: "9000000000" })
      .expect(201)
  ).body.data.id as string;

  // The rival hospital's own item, for the tenant-isolation probe.
  await runWithContext(
    {
      traceId: "setup-rival",
      tenantId: rival.id,
      tenantSlug: RIVAL_SLUG,
      connection: rival.connection,
    },
    async () => undefined,
  );
  rivalItem = (
    await req("post", "/api/v1/inventory-items", rival.admin, rival.host)
      .send({ code: "RIVAL1", name: "Rival gloves", category: "consumable", unit: "box" })
      .expect(201)
  ).body.data.id as string;
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await app.close();
});

/* ── 1. the shelf never goes negative ───────────────────────────────────────── */

describe("1. the shelf cannot go below zero", () => {
  it("issues exactly what is on the shelf — the boundary is legal", async () => {
    const item = await newItem();
    await receive(item, { quantity: 30 }).expect(201);

    const res = await issue(item, { quantity: 30, departmentId: deptWard }).expect(201);
    expect(res.body.data.onHand).toBe(0);
    expect(await onHand(item)).toBe(0);
  });

  it("refuses one more than is there, and says how many there are", async () => {
    const item = await newItem();
    await receive(item, { quantity: 30 }).expect(201);

    const res = await issue(item, { quantity: 31, departmentId: deptWard }).expect(422);
    expect(res.body.error.code).toBe("HMS-INV-002");
    expect(res.body.error.details.onHand).toBe(30);
    expect(res.body.error.details.requested).toBe(31);
  });

  it("a refused issue moves NOTHING — the shelf is unchanged and the ledger is silent", async () => {
    const item = await newItem();
    await receive(item, { quantity: 5 }).expect(201);

    await issue(item, { quantity: 500, departmentId: deptWard }).expect(422);

    expect(await onHand(item)).toBe(5);
    const ledger = await req(
      "get",
      `/api/v1/inventory-items/${item}/movements`,
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    // The receipt, and only the receipt.
    expect(ledger.body.data).toHaveLength(1);
    expect(ledger.body.data[0].kind).toBe("receipt");
  });

  it("refuses an issue from an item that has never been received here", async () => {
    const item = await newItem();
    const res = await issue(item, { quantity: 1, departmentId: deptWard }).expect(422);
    expect(res.body.error.code).toBe("HMS-INV-002");
    expect(res.body.error.details.onHand).toBe(0);
  });

  it("refuses a write-off larger than the shelf, for the same reason", async () => {
    const item = await newItem();
    await receive(item, { quantity: 4 }).expect(201);

    const res = await adjust(item, { delta: -5, reason: "water damage" }).expect(422);
    expect(res.body.error.code).toBe("HMS-INV-002");
    expect(await onHand(item)).toBe(4);
  });

  it("allows a write-off of exactly the shelf, and a correction upward", async () => {
    const item = await newItem();
    await receive(item, { quantity: 4 }).expect(201);

    await adjust(item, { delta: -4, reason: "water damage" }).expect(201);
    expect(await onHand(item)).toBe(0);

    await adjust(item, { delta: 7, reason: "stock-take found a carton" }).expect(201);
    expect(await onHand(item)).toBe(7);
  });

  /**
   * ── THE ONE THE CONDITIONAL UPDATE EXISTS FOR ─────────────────────────────
   * A read-then-write would let both of these pass: each reads 10, each finds it sufficient, each
   * writes. The shelf would end at −10 and the ledger would show two issues of ten from a room
   * that only ever held ten boxes.
   */
  it("two store keepers reaching for the last boxes at once — exactly one wins", async () => {
    const item = await newItem();
    await receive(item, { quantity: 10 }).expect(201);

    const [first, second] = await Promise.all([
      issue(item, { quantity: 10, departmentId: deptWard }),
      issue(item, { quantity: 10, departmentId: deptWard }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 422]);
    expect(await onHand(item)).toBe(0);
  });
});

/* ── 2. the ledger reconciles ───────────────────────────────────────────────── */

describe("2. the ledger reproduces the number on the screen", () => {
  it("on-hand is the sum of every delta, and balanceAfter is the running total", async () => {
    const item = await newItem();
    await receive(item, { quantity: 100 }).expect(201);
    await issue(item, { quantity: 30, departmentId: deptWard }).expect(201);
    await receive(item, { quantity: 20 }).expect(201);
    await adjust(item, { delta: -5, reason: "breakage" }).expect(201);

    const balance = await onHand(item);
    expect(balance).toBe(85);

    const ledger = await req(
      "get",
      `/api/v1/inventory-items/${item}/movements`,
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    const rows = ledger.body.data as { delta: number; balanceAfter: number; kind: string }[];

    expect(rows.map((r) => r.kind)).toEqual(["adjustment", "receipt", "issue", "receipt"]);
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(balance);
    // Newest first, so the first row's running total IS the current shelf.
    expect(rows[0]!.balanceAfter).toBe(balance);
  });

  it("an issue is stored as a NEGATIVE delta, so the sum needs no direction flag", async () => {
    const item = await newItem();
    await receive(item, { quantity: 10 }).expect(201);
    const res = await issue(item, { quantity: 4, departmentId: deptWard }).expect(201);
    expect(res.body.data.movement.delta).toBe(-4);
    expect(res.body.data.movement.balanceAfter).toBe(6);
  });
});

/* ── 3. the shelf belongs to a site ─────────────────────────────────────────── */

describe("3. a store is a room, and the room is at a site", () => {
  it("a delivery booked at one site does not appear at the other", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);

    expect(await onHand(item, keeperToken, siteA)).toBe(40);
    expect(await onHand(item, keeperToken, siteB)).toBe(0);
  });

  it("the same item can be issued at the stocked site and is refused at the empty one", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);

    await issue(item, { quantity: 5, departmentId: deptWard }, siteB).expect(422);
    await issue(item, { quantity: 5, departmentId: deptWard }, siteA).expect(201);
  });

  it("both shelves are kept, independently", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);
    await receive(item, { quantity: 7 }, siteB).expect(201);

    expect(await onHand(item, keeperToken, siteA)).toBe(40);
    expect(await onHand(item, keeperToken, siteB)).toBe(7);
  });

  /**
   * With no site selected the caller sees the sum of the shelves they may reach — which is what
   * "All branches" means everywhere else in this product. It is NOT a hospital-wide figure for a
   * user confined to one site, and the next test is what proves the difference.
   */
  it("the aggregate view sums the sites the caller can reach", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);
    await receive(item, { quantity: 7 }, siteB).expect(201);

    const res = await req("get", "/api/v1/inventory-items", keeperToken, main.host).expect(200);
    const row = (res.body.data as { id: string; onHand: number }[]).find((r) => r.id === item);
    expect(row?.onHand).toBe(47);
  });

  it("a keeper bound to one site sees only that site's shelf, header or no header", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);
    await receive(item, { quantity: 7 }, siteB).expect(201);

    // No header at all — their binding is the whole answer.
    const bare = await req("get", "/api/v1/inventory-items", keeperBToken, main.host).expect(200);
    const bareRow = (bare.body.data as { id: string; onHand: number }[]).find((r) => r.id === item);
    expect(bareRow?.onHand).toBe(7);

    // And asking for the other site's header does not grant it.
    expect(await onHand(item, keeperBToken, siteA)).toBe(7);
  });

  it("a movement records the site it happened at", async () => {
    const item = await newItem();
    const res = await receive(item, { quantity: 3 }, siteB).expect(201);
    expect(res.body.data.movement.branchId).toBe(siteB);
  });

  it("the history a confined keeper reads is their own site's", async () => {
    const item = await newItem();
    await receive(item, { quantity: 40 }, siteA).expect(201);
    await receive(item, { quantity: 7 }, siteB).expect(201);

    const res = await req(
      "get",
      `/api/v1/inventory-items/${item}/movements`,
      keeperBToken,
      main.host,
    ).expect(200);
    const rows = res.body.data as { branchId?: string; delta: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe(siteB);
  });
});

/* ── 4. stock that leaves arrives somewhere nameable ────────────────────────── */

describe("4. a movement can be traced to a party", () => {
  it("captures the supplier's name on the receipt, so a rename cannot rewrite history", async () => {
    const item = await newItem();
    const res = await receive(item, {
      quantity: 10,
      supplierId,
      invoiceRef: "INV-2031-88",
      unitCost: 145.5,
    }).expect(201);

    expect(res.body.data.movement.supplierId).toBe(supplierId);
    expect(res.body.data.movement.supplierName).toBe("Acme Surgical");
    expect(res.body.data.movement.invoiceRef).toBe("INV-2031-88");
    expect(res.body.data.movement.unitCost).toBe(145.5);

    await req("patch", `/api/v1/suppliers/${supplierId}`, keeperToken, main.host, siteA)
      .send({ name: "Acme Surgical Supplies Ltd" })
      .expect(200);

    const ledger = await req(
      "get",
      `/api/v1/inventory-items/${item}/movements`,
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    expect(ledger.body.data[0].supplierName).toBe("Acme Surgical");
  });

  it("captures the department on an issue", async () => {
    const item = await newItem();
    await receive(item, { quantity: 10 }).expect(201);
    const res = await issue(item, { quantity: 4, departmentId: deptWard }).expect(201);
    expect(res.body.data.movement.departmentId).toBe(deptWard);
    expect(res.body.data.movement.departmentName).toBe("General Ward");
  });

  /**
   * Stock issued to a department that does not exist has left the store and arrived nowhere. The
   * ledger would balance and the hospital would have lost it, which is the failure a stock system
   * is supposed to make impossible.
   */
  it("refuses an issue to a department that does not exist, and moves nothing", async () => {
    const item = await newItem();
    await receive(item, { quantity: 10 }).expect(201);

    const res = await issue(item, { quantity: 4, departmentId: FORGED }).expect(404);
    expect(res.body.error.code).toBe("HMS-GEN-404");
    expect(await onHand(item)).toBe(10);
  });

  /**
   * The route exists because `GET /departments` is gated on `patient:read`, and a store keeper
   * must never hold that. This asserts BOTH halves: the keeper can read the destinations they
   * need, and cannot read the patient list they do not.
   */
  it("a store keeper can read issue destinations without being able to read patients", async () => {
    const res = await req(
      "get",
      "/api/v1/inventory-destinations",
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    const rows = res.body.data as { id: string; name: string }[];
    expect(rows.some((d) => d.id === deptWard)).toBe(true);
    // The smallest honest answer — a label and a value, nothing about the hospital's structure.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["id", "name"]);

    await req("get", "/api/v1/patients", keeperToken, main.host, siteA).expect(403);
    await req("get", "/api/v1/departments", keeperToken, main.host, siteA).expect(403);
  });

  it("refuses a receipt attributed to a supplier that does not exist", async () => {
    const item = await newItem();
    const res = await receive(item, { quantity: 10, supplierId: FORGED }).expect(404);
    expect(res.body.error.code).toBe("HMS-GEN-404");
    expect(await onHand(item)).toBe(0);
  });
});

/* ── 5. the boundaries ──────────────────────────────────────────────────────── */

describe("5. the boundaries hold", () => {
  it("another hospital's item is simply not found", async () => {
    await req(
      "get",
      `/api/v1/inventory-items/${rivalItem}/movements`,
      keeperToken,
      main.host,
      siteA,
    )
      .expect(200)
      .expect((r) => expect(r.body.data).toEqual([]));

    await receive(rivalItem, { quantity: 10 }).expect(404);
  });

  /**
   * Layer 1 before layer 2 (ADR-0010): the hospital that never bought the store is told the
   * MODULE is missing, not that it lacks a permission — otherwise its administrator goes hunting
   * through the role editor for a grant that can never help. Every route, read and write alike.
   */
  it("answers HMS-PLAN-002 on every store route for a hospital without the module", async () => {
    const probes: ["get" | "post" | "patch", string, Record<string, unknown>?][] = [
      ["get", "/api/v1/inventory-items"],
      ["get", "/api/v1/inventory-destinations"],
      [
        "post",
        "/api/v1/inventory-items",
        { code: "X", name: "x", category: "consumable", unit: "box" },
      ],
      ["patch", `/api/v1/inventory-items/${FORGED}`, { reorderLevel: 1 }],
      ["get", `/api/v1/inventory-items/${FORGED}/movements`],
      ["post", `/api/v1/inventory-items/${FORGED}/receive`, { quantity: 1 }],
      ["post", `/api/v1/inventory-items/${FORGED}/issue`, { quantity: 1, departmentId: FORGED }],
      ["post", `/api/v1/inventory-items/${FORGED}/adjust`, { delta: 1, reason: "x" }],
      ["get", "/api/v1/suppliers"],
      ["post", "/api/v1/suppliers", { code: "X", name: "x" }],
      ["patch", `/api/v1/suppliers/${FORGED}`, { name: "x" }],
    ];

    for (const [method, path, body] of probes) {
      const res = await req(method, path, clinic.admin, clinic.host).send(body ?? {});
      expect(res.body.error?.code, `${method} ${path} was not entitlement-gated`).toBe(
        "HMS-PLAN-002",
      );
    }
  });

  it("and an entitled hospital reaches the same route", async () => {
    await req("get", "/api/v1/inventory-items", main.admin, main.host, siteA).expect(200);
  });

  it("a nurse cannot read the shelf or move anything", async () => {
    await req("get", "/api/v1/inventory-items", nurseToken, main.host, siteA).expect(403);
    const item = await newItem();
    await issue(item, { quantity: 1, departmentId: deptWard }, siteA, nurseToken).expect(403);
  });

  it("an item code is unique per hospital, and the refusal says so", async () => {
    itemSeq += 1;
    const body = {
      code: `DUP${itemSeq}`,
      name: "Duplicate probe",
      category: "consumable" as const,
      unit: "box" as const,
    };
    await req("post", "/api/v1/inventory-items", keeperToken, main.host, siteA)
      .send(body)
      .expect(201);
    const res = await req("post", "/api/v1/inventory-items", keeperToken, main.host, siteA)
      .send(body)
      .expect(409);
    expect(res.body.error.code).toBe("HMS-VAL-001");
  });

  /**
   * The same code at ANOTHER hospital is a different item. Uniqueness is per tenant, and this is
   * the assertion that the index is keyed on `tenantId` rather than on `code` alone.
   */
  it("the same code at another hospital is accepted", async () => {
    await req("post", "/api/v1/inventory-items", rival.admin, rival.host)
      .send({ code: "ITEM1", name: "Rival's own", category: "consumable", unit: "box" })
      .expect(201);
  });

  it("a replayed delivery books ONE receipt, not two", async () => {
    const item = await newItem();
    const key = `store-receive-${String(itemSeq)}`;

    const first = await receive(item, { quantity: 50 }, siteA, key).expect(201);
    const replay = await receive(item, { quantity: 50 }, siteA, key).expect(201);

    expect(replay.body.data.movement.id).toBe(first.body.data.movement.id);
    expect(await onHand(item)).toBe(50);
  });

  it("a body that names a branch is refused outright — the site comes from the context", async () => {
    const item = await newItem();
    await receive(item, { quantity: 10, branchId: siteB }).expect(400);
  });
});

/* ── 6. the list a store keeper actually opens ──────────────────────────────── */

describe("6. the store list", () => {
  it("calls an item low at or below its reorder level, and out at zero", async () => {
    const low = await newItem(20);
    await receive(low, { quantity: 20 }).expect(201);
    const out = await newItem(20);
    const fine = await newItem(20);
    await receive(fine, { quantity: 21 }).expect(201);

    const res = await req("get", "/api/v1/inventory-items", keeperToken, main.host, siteA).expect(
      200,
    );
    const rows = res.body.data as { id: string; position: string }[];
    expect(rows.find((r) => r.id === low)?.position).toBe("low");
    expect(rows.find((r) => r.id === out)?.position).toBe("out");
    expect(rows.find((r) => r.id === fine)?.position).toBe("ok");
  });

  it("a zero reorder level means no alert — an item with stock is never 'low'", async () => {
    const item = await newItem(0);
    await receive(item, { quantity: 1 }).expect(201);
    const res = await req("get", "/api/v1/inventory-items", keeperToken, main.host, siteA).expect(
      200,
    );
    const row = (res.body.data as { id: string; position: string }[]).find((r) => r.id === item);
    expect(row?.position).toBe("ok");
  });

  it("`lowStockOnly` returns everything needing attention and nothing that does not", async () => {
    const res = await req(
      "get",
      "/api/v1/inventory-items?lowStockOnly=true",
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    const rows = res.body.data as { position: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.position !== "ok")).toBe(true);
  });

  /** A retired item keeps its history and leaves the list — the same rule as the medicine master. */
  it("hides a discontinued item unless asked for it", async () => {
    const item = await newItem();
    await req("patch", `/api/v1/inventory-items/${item}`, keeperToken, main.host, siteA)
      .send({ active: false })
      .expect(200);

    const hidden = await req(
      "get",
      "/api/v1/inventory-items",
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    expect((hidden.body.data as { id: string }[]).some((r) => r.id === item)).toBe(false);

    const shown = await req(
      "get",
      "/api/v1/inventory-items?includeInactive=true",
      keeperToken,
      main.host,
      siteA,
    ).expect(200);
    expect((shown.body.data as { id: string }[]).some((r) => r.id === item)).toBe(true);
  });
});
