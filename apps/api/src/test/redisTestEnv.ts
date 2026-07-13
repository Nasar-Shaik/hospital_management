/**
 * Integration-test harness against a REAL Redis (Doc 05 §4.2).
 *
 * The auth suite needs this because the access-token blocklist lives in Redis.
 * Application code treats a Redis outage as fail-soft, which means that WITHOUT
 * a real Redis every blocklist assertion would silently pass — a logged-out
 * token would look revoked when nothing had been revoked at all. So, like the
 * Mongo harness, this FAILS rather than skips.
 */
import { Redis } from "ioredis";

/** Local dev uses the docker compose redis on 6380 (default port is taken — PROJECT_MEMORY §8). */
export const TEST_REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";

export async function assertRedisReachable(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Integration tests require Redis at ${TEST_REDIS_URL}.\n` +
        `Start it with: pnpm docker:dev  (or set REDIS_TEST_URL)\n` +
        `Underlying error: ${String(err)}`,
    );
  } finally {
    redis.disconnect();
  }
}

/**
 * Clears cached state between runs.
 *
 * REQUIRED, not hygiene: the tenant registry is a read-through cache, so a test
 * that drops the master database while `tenant:{slug}` is still cached will keep
 * resolving the tenant it just deleted, and the next run fails with a confusing
 * "slug already taken". Dropping Mongo without dropping Redis leaves the harness
 * in a state the application never produces on its own.
 */
export async function flushTestCache(): Promise<void> {
  // `flushdb` is destructive, and loopback does not prove the server is ours —
  // a tunnel or another project's container can hold the same local port (see
  // mongoTestEnv.assertLocalDevMongo, and PROJECT_MEMORY §8).
  const host = new URL(TEST_REDIS_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `REFUSING TO FLUSH: REDIS_TEST_URL points at a non-loopback host (${host}). ` +
        `Tests flush the whole database and may only do so against a local, disposable Redis.`,
    );
  }

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
