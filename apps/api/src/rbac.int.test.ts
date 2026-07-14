/**
 * RBAC MATRIX SUITE — release-gating (ADR-0010, Doc 05 §4.2, RISK_REGISTER).
 *
 * ── WHAT THIS DEFENDS, AND WHY IT EXISTS NOW ─────────────────────────────────
 * Authorization is the only thing standing between a hospital's patient records
 * and everybody else. It is enforced by three layers (entitlement → permission →
 * row scope), and every one of them is a per-route decision a developer has to
 * remember to make. The failure mode is silent by construction: a route with no
 * `authorize()` does not throw, does not warn, and looks fine in review — it just
 * quietly answers everyone.
 *
 * This project has now shipped TWO authorization bugs that were found by accident
 * rather than by testing, and both are the kind this suite catches mechanically:
 *
 *   A2  `plan:manage` sat in the wrong permission group, so TENANT_ADMIN inherited
 *       it and a hospital could upgrade ITSELF to Enterprise — for free.
 *   P2  `patients` became the first `branch`-scoped resource, and an empty
 *       `branchIds` meant "everywhere" to RBAC and "nowhere" to the row filter.
 *       The patient list came back EMPTY for every user in every hospital.
 *
 * Neither was caught by review. Both would have been caught here, on the first run.
 *
 * ── THE PART THAT MATTERS MOST IS THE COVERAGE TEST ──────────────────────────
 * Any suite can assert that a route we thought about is protected. The hard problem
 * is the route nobody thought about. So this suite does not hold a hand-written list
 * of routes — it reads the SHIPPED Express app (`routeInventory`) and asserts:
 *
 *   1. Every `/api/v1` route is either declared PUBLIC here, or carries both
 *      `authenticate()` and a permission. A new unprotected route FAILS CI.
 *   2. Every protected route's permission exists in the catalog. A typo'd constant
 *      cannot silently create a permission nobody holds (or worse, everybody does).
 *
 * That is the difference between testing our authorization and testing the
 * authorization we remembered to test.
 *
 * ── AND THE EXPECTATIONS ARE DERIVED, NOT TYPED ──────────────────────────────
 * The per-role expectations below are computed FROM `DEFAULT_ROLES` in the
 * permission catalog — the same data the app seeds from. A hand-written expectation
 * table would be a second source of truth that drifts, and a test that drifts
 * toward the code it is testing eventually asserts nothing. Here, if someone widens
 * a role, the expected outcome changes with it AND the guard tests below (which
 * assert specific, deliberate facts — "a nurse cannot create users", "a tenant admin
 * cannot re-price its own hospital") fail loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { DEFAULT_ROLES, PERMISSIONS, ALL_PERMISSION_CODES } from "@medicore/permissions";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, TEST_REDIS_URL } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.MONGO_MASTER_DB = "test_rbac_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { createApp } = await import("./app.js");
const { routeInventory } = await import("./core/http/routeInventory.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { signPlatformToken } = await import("./core/crypto/jwt.js");

const SLUG_A = "test-rbac-apollo";
const SLUG_B = "test-rbac-sunshine";
const DB_A = `hms_${SLUG_A}`;
const DB_B = `hms_${SLUG_B}`;
const HOST_A = `${SLUG_A}.medicore.test`;
const HOST_B = `${SLUG_B}.medicore.test`;

const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "rbac-int-test" }));

interface Tenant {
  id: string;
  slug: string;
  databaseName: string;
}
let tenantA: Tenant;
let tenantB: Tenant;

/**
 * The `/api/v1` routes that may be reached with NO token.
 *
 * This list is the entire unauthenticated attack surface of a hospital, and it is
 * declared here on purpose: adding a route to it is a deliberate, reviewable act,
 * not something that happens by forgetting a middleware.
 */
const PUBLIC_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/mfa/verify",
]);

/**
 * Routes behind `authenticate()` that intentionally carry NO permission: things
 * every signed-in person may do to their OWN account. A permission here would be
 * absurd (you would need `session:read` to see your own sessions), but the list is
 * still explicit — "no permission required" must be a decision, never a gap.
 */
const SELF_SERVICE_ROUTES = new Set([
  "POST /api/v1/auth/logout",
  "GET /api/v1/auth/me",
  "POST /api/v1/auth/change-password",
  "GET /api/v1/auth/sessions",
  "DELETE /api/v1/auth/sessions/:id",
  "POST /api/v1/auth/mfa/setup",
  "POST /api/v1/auth/mfa/activate",
  "POST /api/v1/auth/mfa/disable",
]);

/** A concrete, callable request for each protected route — the matrix's probes. */
interface Probe {
  method: "get" | "post" | "patch" | "put" | "delete";
  /** A real URL (params substituted). */
  url: string;
  body?: Record<string, unknown>;
}

/**
 * One probe per protected route. Keyed by the SAME `METHOD /path` string the route
 * inventory produces, which is what lets the coverage test prove every route has one.
 *
 * The bodies are deliberately valid-ish but harmless. We are testing the
 * authorization decision, which happens BEFORE the handler — a 400 from validation
 * would still prove we got past `authorize`, and a 403 proves we did not. Nothing
 * here needs to succeed for the matrix to be meaningful; it needs to be *reached*.
 */
const PROBES: Record<string, Probe> = {
  "GET /api/v1/permissions": { method: "get", url: "/api/v1/permissions" },
  "GET /api/v1/roles": { method: "get", url: "/api/v1/roles" },
  "GET /api/v1/roles/:id": { method: "get", url: "/api/v1/roles/64b7f0000000000000000001" },
  "POST /api/v1/roles": { method: "post", url: "/api/v1/roles", body: { code: "X", name: "X" } },
  "PUT /api/v1/roles/:id/permissions": {
    method: "put",
    url: "/api/v1/roles/64b7f0000000000000000001/permissions",
    body: { permissions: [] },
  },
  "DELETE /api/v1/roles/:id": {
    method: "delete",
    url: "/api/v1/roles/64b7f0000000000000000001",
  },
  "POST /api/v1/users/:id/roles": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/roles",
    body: { role: "NURSE" },
  },
  "DELETE /api/v1/users/:id/roles/:roleCode": {
    method: "delete",
    url: "/api/v1/users/64b7f0000000000000000001/roles/NURSE",
  },
  "GET /api/v1/users": { method: "get", url: "/api/v1/users" },
  "GET /api/v1/users/:id": { method: "get", url: "/api/v1/users/64b7f0000000000000000001" },
  "POST /api/v1/users": {
    method: "post",
    url: "/api/v1/users",
    body: { email: "probe@x.test", name: "Probe" },
  },
  "PATCH /api/v1/users/:id": {
    method: "patch",
    url: "/api/v1/users/64b7f0000000000000000001",
    body: { name: "Probe" },
  },
  "POST /api/v1/users/:id/status": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/status",
    body: { status: "disabled" },
  },
  "POST /api/v1/users/:id/reset-password": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/reset-password",
    body: {},
  },
  "GET /api/v1/subscription": { method: "get", url: "/api/v1/subscription" },
  "GET /api/v1/plans": { method: "get", url: "/api/v1/plans" },
  "POST /api/v1/subscription/plan": {
    method: "post",
    url: "/api/v1/subscription/plan",
    body: { planCode: "PLAN_CLINIC" },
  },
  "POST /api/v1/feature-flags": {
    method: "post",
    url: "/api/v1/feature-flags",
    body: { feature: "module.ops.appointments", enabled: true },
  },
  "GET /api/v1/audit": { method: "get", url: "/api/v1/audit" },
  "GET /api/v1/audit/export": { method: "get", url: "/api/v1/audit/export" },
  "GET /api/v1/audit/integrity": { method: "get", url: "/api/v1/audit/integrity" },
  "GET /api/v1/patients": { method: "get", url: "/api/v1/patients" },
  "GET /api/v1/patients/by-uhid/:uhid": { method: "get", url: "/api/v1/patients/by-uhid/UH000001" },
  "GET /api/v1/patients/:id": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001",
  },
  "POST /api/v1/patients": {
    method: "post",
    url: "/api/v1/patients",
    body: { name: "Probe Patient", gender: "female" },
  },
  "POST /api/v1/patients/check-duplicates": {
    method: "post",
    url: "/api/v1/patients/check-duplicates",
    body: { name: "Probe Patient" },
  },
  "PATCH /api/v1/patients/:id": {
    method: "patch",
    url: "/api/v1/patients/64b7f0000000000000000001",
    body: { name: "Probe Patient" },
  },
  "POST /api/v1/patients/merge": {
    method: "post",
    url: "/api/v1/patients/merge",
    body: {
      survivorId: "64b7f0000000000000000001",
      duplicateId: "64b7f0000000000000000002",
      reason: "matrix probe",
    },
  },
};

/** The roles under test. Chosen to span the privilege range, not to be exhaustive. */
const ROLES_UNDER_TEST = ["TENANT_ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST"] as const;
type TestedRole = (typeof ROLES_UNDER_TEST)[number];

/** Permission codes each role holds — read from the catalog the app itself seeds from. */
function permissionsOf(roleCode: string): Set<string> {
  const role = DEFAULT_ROLES.find((r) => r.code === roleCode);
  if (!role) throw new Error(`unknown role in matrix: ${roleCode}`);

  const held = new Set(role.permissions);

  /**
   * A guard against the subtlest way this whole suite could rot: if `permissions`
   * ever changed shape (objects instead of codes, say), this would silently become
   * an empty set — and an empty set means "expect 403 everywhere", which every
   * denied route would happily satisfy. The suite would go green while asserting
   * that nobody can do anything. A test that passes vacuously is worse than no test.
   */
  if (held.size === 0) {
    throw new Error(`role ${roleCode} resolved to ZERO permissions — the catalog shape changed`);
  }
  return held;
}

const tokens: Record<TestedRole | "noRole", string> = {} as never;
let tokenTenantB = "";

/**
 * Seeds the permission catalog and the 11 default roles into a tenant.
 *
 * `provisionTenant` creates the database and runs migrations; it does NOT seed
 * RBAC — that is `seedTenantAdmin`'s job in the real flow. Calling it explicitly
 * here keeps the suite honest about what it is testing: the roles under test are
 * the ones the product actually ships, seeded by the code that actually ships.
 */
async function seedRoles(tenant: Tenant): Promise<void> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  await runWithContext(
    { traceId: "rbac-setup", tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    async () => {
      await seedRbac();
    },
  );
}

async function createUserWithRole(
  tenant: Tenant,
  email: string,
  roleCode?: string,
  branchIds?: string[],
): Promise<void> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  await runWithContext(
    { traceId: "rbac-setup", tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    async () => {
      const user = await createUser({ email, name: email, status: "invited" });
      await setPassword(user.id, PASSWORD, { mustChangePassword: false });
      if (roleCode) await assignRoleByCode(user.id, roleCode, branchIds ?? []);
      await transitionStatus(user.id, "active");
    },
  );
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });

  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_rbac_master", DB_A, DB_B]);
  await flushTestCache();

  const a = await provisionTenant({ hospitalName: "Apollo RBAC", slug: SLUG_A });
  const b = await provisionTenant({ hospitalName: "Sunshine RBAC", slug: SLUG_B });
  tenantA = { id: a.tenant.id, slug: SLUG_A, databaseName: a.tenant.databaseName };
  tenantB = { id: b.tenant.id, slug: SLUG_B, databaseName: b.tenant.databaseName };

  await seedRoles(tenantA);
  await seedRoles(tenantB);

  for (const role of ROLES_UNDER_TEST) {
    await createUserWithRole(tenantA, `${role.toLowerCase()}@apollo.test`, role);
  }
  // A user with NO role at all — the baseline. They can authenticate and do nothing,
  // which is the correct default for an account somebody created and forgot to grant.
  await createUserWithRole(tenantA, "norole@apollo.test");

  await createUserWithRole(tenantB, "admin@sunshine.test", "TENANT_ADMIN");

  for (const role of ROLES_UNDER_TEST) {
    tokens[role] = await login(HOST_A, `${role.toLowerCase()}@apollo.test`);
  }
  tokens.noRole = await login(HOST_A, "norole@apollo.test");
  tokenTenantB = await login(HOST_B, "admin@sunshine.test");
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_rbac_master", DB_A, DB_B]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. COVERAGE — the test that makes the rest of the suite trustworthy.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("route coverage (the unprotected-route problem)", () => {
  const routes = routeInventory(app).filter((r) => r.path.startsWith("/api/v1"));
  const key = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

  it("finds the tenant API surface (guards against the inventory silently returning nothing)", () => {
    // If `routeInventory` ever breaks — an Express upgrade changes the router
    // internals, say — it would return [] and EVERY test below would pass
    // vacuously. This suite would then be green while asserting nothing at all,
    // which is worse than having no suite. So it must find real routes first.
    expect(routes.length).toBeGreaterThan(20);
  });

  it("every /api/v1 route is public by declaration, self-service, or permission-protected", () => {
    const unprotected = routes.filter((route) => {
      const id = key(route);
      if (PUBLIC_ROUTES.has(id) || SELF_SERVICE_ROUTES.has(id)) return false;
      return !route.authenticates || !route.permission;
    });

    expect(
      unprotected.map(key),
      "These routes have no permission. Add `authorize(PERMISSIONS.X)`, or declare them " +
        "in PUBLIC_ROUTES/SELF_SERVICE_ROUTES if that is genuinely intended.",
    ).toEqual([]);
  });

  it("every permission a route requires actually exists in the catalog", () => {
    // Catches a route wired to a permission code that no role can ever hold —
    // which would make the route permanently unreachable (annoying), or, if the
    // check were ever loosened, universally reachable (a breach).
    const unknown = routes
      .filter((r) => r.permission && !ALL_PERMISSION_CODES.includes(r.permission))
      .map((r) => `${key(r)} → ${r.permission ?? ""}`);

    expect(unknown, "Route requires a permission that is not in the catalog").toEqual([]);
  });

  it("every permission-protected route has a probe in the matrix", () => {
    const missing = routes
      .filter((r) => r.permission)
      .map(key)
      .filter((id) => !(id in PROBES));

    expect(
      missing,
      "A new protected route shipped without anyone deciding which roles may call it. " +
        "Add it to PROBES — that is the point of this failure.",
    ).toEqual([]);
  });

  it("no probe refers to a route that no longer exists", () => {
    // The other direction: a stale probe would be a test that passes while
    // exercising nothing.
    const live = new Set(routes.map(key));
    expect(Object.keys(PROBES).filter((id) => !live.has(id))).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE MATRIX — every tested role against every protected route.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the matrix: role × route", () => {
  const routes = routeInventory(app).filter((r) => r.path.startsWith("/api/v1") && r.permission);

  for (const role of ROLES_UNDER_TEST) {
    const held = permissionsOf(role);

    for (const route of routes) {
      const id = `${route.method} ${route.path}`;
      const probe = PROBES[id];
      if (!probe || !route.permission) continue;

      const shouldAllow = held.has(route.permission);

      it(`${role} ${shouldAllow ? "may" : "may NOT"} ${id}`, async () => {
        const res = await request(app)
          [probe.method](probe.url)
          .set("Host", HOST_A)
          .set("Authorization", `Bearer ${tokens[role]}`)
          .send(probe.body ?? {});

        if (shouldAllow) {
          /**
           * "Allowed" means the authorization chain let the request THROUGH — not
           * that the handler succeeded. A probe pointing at a nonexistent id gets a
           * 404, and a deliberately thin body gets a 400; both prove we got past
           * `authorize`, which is the only thing this suite is asking.
           *
           * What must never appear is 403.
           */
          expect(
            res.status,
            `${role} was denied ${id} but holds ${route.permission ?? ""}`,
          ).not.toBe(403);
        } else {
          expect(res.status, `${role} reached ${id} without ${route.permission ?? ""}`).toBe(403);
          expect(res.body.error.code).toBe("HMS-AUTH-005");
        }
      });
    }
  }

  it("a user with no role can authenticate and do nothing", async () => {
    // The safe default. An account created and never granted anything must be
    // useless, not quietly powerful.
    for (const [id, probe] of Object.entries(PROBES)) {
      const res = await request(app)
        [probe.method](probe.url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.noRole}`)
        .send(probe.body ?? {});

      expect(res.status, `an unroled user reached ${id}`).toBe(403);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. DELIBERATE FACTS — the specific things we must never regress.
 *
 * The matrix above is derived from the catalog, so it moves when the catalog
 * moves. These do not. They are the assertions that would have FAILED on the day
 * each real bug was introduced, and they exist to make that failure loud.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("privilege boundaries that must never move", () => {
  it("TENANT_ADMIN cannot change its own hospital's plan (the A2 escalation hole)", async () => {
    // `plan:manage` lived in the ordinary platform group once, so TENANT_ADMIN
    // inherited it and the demo hospital upgraded ITSELF to Enterprise. A customer
    // could have taken the top edition for free. This is the test that says never again.
    const res = await request(app)
      .post("/api/v1/subscription/plan")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ planCode: "PLAN_ENTERPRISE" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("TENANT_ADMIN cannot switch on a feature the hospital never bought", async () => {
    const res = await request(app)
      .post("/api/v1/feature-flags")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ feature: "module.clinical.dialysis", enabled: true });

    expect(res.status).toBe(403);
  });

  it("TENANT_ADMIN holds neither superadmin permission, in the catalog itself", () => {
    const admin = permissionsOf("TENANT_ADMIN");
    for (const forbidden of [
      PERMISSIONS.PLAN_MANAGE,
      PERMISSIONS.FEATUREFLAG_MANAGE,
      PERMISSIONS.SUPERADMIN_TENANT_MANAGE,
      PERMISSIONS.TENANT_IMPERSONATE,
      PERMISSIONS.TENANT_EXPORT,
    ]) {
      expect(admin.has(forbidden.code), `TENANT_ADMIN must never hold ${forbidden.code}`).toBe(
        false,
      );
    }
  });

  it("a NURSE cannot create user accounts or assign roles", async () => {
    // The privilege-escalation path: anyone who can grant a role can grant
    // themselves any role. It must not come free with clinical duties.
    for (const probe of [PROBES["POST /api/v1/users"], PROBES["POST /api/v1/users/:id/roles"]]) {
      const res = await request(app)
        [probe!.method](probe!.url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.NURSE}`)
        .send(probe!.body ?? {});
      expect(res.status).toBe(403);
    }
  });

  it("a RECEPTIONIST may register a patient but may NOT merge two of them", async () => {
    // Registration is the front desk's whole job. Merging is irreversible and is a
    // clinical judgement about identity — it must not arrive free with the till.
    const register = await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`)
      .send({ name: "Walk In", gender: "female" });
    expect(register.status).toBe(201);

    const merge = await request(app)
      .post("/api/v1/patients/merge")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`)
      .send({
        survivorId: "64b7f0000000000000000001",
        duplicateId: "64b7f0000000000000000002",
        reason: "receptionist should not be able to do this",
      });
    expect(merge.status).toBe(403);
    expect(merge.body.error.code).toBe("HMS-AUTH-005");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE TENANCY BOUNDARY — a permission is worthless if it crosses hospitals.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("permissions do not cross the tenancy boundary", () => {
  it("a fully-privileged admin of one hospital is refused at another", async () => {
    // Sunshine's TENANT_ADMIN holds 139 permissions — at Sunshine. At Apollo they
    // hold nothing, and the refusal happens BEFORE any permission is consulted,
    // because the token's `tid` does not match the host-resolved tenant.
    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokenTenantB}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-TEN-003");
  });

  it("an OPERATOR token cannot authorize inside a hospital", async () => {
    // A platform token carries no `tid` at all, so it can never match a
    // host-resolved tenant. Structural, not a check somebody could forget.
    const { token: operatorToken } = await signPlatformToken({
      userId: "64b7f0000000000000000009",
      email: "ops@paperlesstech.in",
      roles: ["SUPER_ADMIN"],
    });

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${operatorToken}`);

    // 401, not 500: a stale operator tab hitting a tenant route is a routine
    // event, not an exception. (This was a real bug — it used to 500.)
    expect(res.status).toBe(401);
  });

  it("a TENANT token cannot reach the operator console", async () => {
    const res = await request(app)
      .get("/api/platform/v1/hospitals")
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`);

    expect(res.status).toBe(401);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. ROW SCOPE (layer 3) — the layer the middleware cannot enforce alone.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("row scope: branch confinement (the P2 bug, pinned)", () => {
  const BRANCH_X = "64b7f0000000000000000aaa";
  const BRANCH_Y = "64b7f0000000000000000bbb";

  it("a hospital-wide binding sees every patient", async () => {
    // The bug: an empty `branchIds` meant "everywhere" to RBAC and "nowhere" to the
    // row filter, so this returned ZERO patients — for the admin who had just
    // registered them. `patient:read` is `branch`-scoped, so this is the exact path.
    await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ name: "Scope Visible", gender: "male", branchId: BRANCH_X })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .expect(200);

    expect(res.body.data.length, "a hospital-wide admin must see patients").toBeGreaterThan(0);
  });

  it("a branch-confined user sees ONLY their branch's patients", async () => {
    await createUserWithRole(tenantA, "branchnurse@apollo.test", "NURSE", [BRANCH_X]);
    const confined = await login(HOST_A, "branchnurse@apollo.test");

    // One patient in each branch, plus the unassigned ones already registered above.
    await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ name: "Other Branch Patient", gender: "female", branchId: BRANCH_Y })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${confined}`)
      .expect(200);

    const branches = (res.body.data as { branchId?: string }[]).map((p) => p.branchId);
    expect(
      branches.every((b) => b === BRANCH_X),
      `a confined nurse saw ${branches.join(",")}`,
    ).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});
