/**
 * REGISTRY CACHE — release-gating (Doc 04 §2.2.1, CACHE_STRATEGY).
 *
 * A SEPARATE suite from `tenancy.int.test.ts` on purpose. That one deliberately
 * runs with NO Redis (`delete process.env.REDIS_URL`) so the isolation properties
 * are proved against the database itself, with no cache able to mask them. Which
 * means it is exactly the wrong place to test a cache: every assertion would have
 * passed vacuously, including the one below that only means anything when a cache
 * exists.
 *
 * ── WHAT THIS DEFENDS ───────────────────────────────────────────────────────
 * The master registry is the single database that routes EVERY hospital on the
 * platform. Degrade it and nobody can reach any hospital — it is the one component
 * whose failure is platform-wide rather than per-customer.
 *
 * We publish wildcard DNS (`*.paperlesstech.in`), so a stranger can spray
 * `a1.paperlesstech.in`, `a2.…`, `a3.…` for as long as they like. If a miss is not
 * cached, every one of those requests is an uncached query against that registry:
 * a denial of service that costs the attacker nothing and takes routing down for
 * every customer at once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, TEST_REDIS_URL } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.MONGO_MASTER_DB = "test_regcache_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";
// The point of this suite: a REAL cache.
process.env.REDIS_URL = TEST_REDIS_URL;

const { provisionTenant } = await import("./modules/tenants/index.js");
const { resolveTenantFromHost } = await import("./middleware/resolveTenant.js");
const { closeAllTenantConnections } = await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { cacheGet, cacheKeys, closeRedis } = await import("./core/redis/redis.js");

const SLUG = "test-regcache";
const DB = `hms_${SLUG}`;

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_regcache_master", DB]);
  await flushTestCache();

  await provisionTenant({
    hospitalName: "Registry Cache Hospital",
    slug: SLUG,
    planCode: "PLAN_CLINIC",
  });
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_regcache_master", DB]);
}, 30_000);

describe("an unknown host is REMEMBERED, so a flood of bad hosts cannot hammer the master DB", () => {
  it("caches the absence of a host that does not exist", async () => {
    const slug = "definitely-not-a-hospital";
    expect(await resolveTenantFromHost(`${slug}.medicore.test`)).toBeUndefined();

    // The miss is now in Redis, so the second request — and the millionth — costs
    // the registry nothing.
    const cached = await cacheGet<{ absent?: boolean }>(cacheKeys.tenantBySlug(slug));
    expect(cached?.absent).toBe(true);
  });

  it("a cached absence still resolves to NOTHING, never to a phantom tenant", async () => {
    const host = "also-not-a-hospital.medicore.test";

    expect(await resolveTenantFromHost(host)).toBeUndefined();
    // Served from cache this time. The marker must not be mistaken for a tenant —
    // a bug here would hand a caller an object with no databaseName and send it
    // looking for a database that does not exist.
    expect(await resolveTenantFromHost(host)).toBeUndefined();
  });

  it("a real hospital is still cached and still resolves", async () => {
    const tenant = await resolveTenantFromHost(`${SLUG}.medicore.test`);
    expect(tenant?.slug).toBe(SLUG);

    const cached = await cacheGet<{ slug?: string; absent?: boolean }>(
      cacheKeys.tenantBySlug(SLUG),
    );
    expect(cached?.slug).toBe(SLUG);
    expect(cached?.absent).toBeUndefined();
  });
});

/**
 * THE BUG NEGATIVE CACHING INTRODUCES — and the reason `create()` invalidates.
 *
 * A slug gets probed before it exists (a typo, a crawler, an operator checking
 * whether the name is free) and is now cached as ABSENT. Provision that same slug
 * and, if nobody forgets the absence, the brand-new hospital 404s for the rest of
 * the miss TTL — and the person it 404s at is the customer we onboarded thirty
 * seconds ago, on their very first visit.
 *
 * Remembering an absence obliges you to forget it the instant it stops being true.
 */
describe("the absence is forgotten the instant the hospital is born", () => {
  it("a slug probed BEFORE provisioning resolves immediately AFTER it", async () => {
    const slug = "test-probed-before-birth";
    const host = `${slug}.medicore.test`;

    // 1. Somebody asks for it before it exists. Now cached as absent.
    expect(await resolveTenantFromHost(host)).toBeUndefined();
    expect((await cacheGet<{ absent?: boolean }>(cacheKeys.tenantBySlug(slug)))?.absent).toBe(true);

    // 2. We sell it to them.
    const provisioned = await provisionTenant({
      hospitalName: "Probed Before Birth",
      slug,
      planCode: "PLAN_CLINIC",
    });

    // 3. It works on the first request — no waiting for a TTL to lapse.
    const resolved = await resolveTenantFromHost(host);
    expect(resolved?.id).toBe(provisioned.tenant.id);

    await dropDatabases([`hms_${slug}`]);
  }, 60_000);
});
