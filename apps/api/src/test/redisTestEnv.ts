/**
 * Integration-test harness against a REAL Redis (Doc 05 §4.2).
 *
 * The auth suite needs this because the access-token blocklist lives in Redis.
 * Application code treats a Redis outage as fail-soft, which means that WITHOUT
 * a real Redis every blocklist assertion would silently pass — a logged-out
 * token would look revoked when nothing had been revoked at all. So, like the
 * Mongo harness, this FAILS rather than skips.
 *
 * ── WHY EVERY SUITE GETS ITS OWN LOGICAL DATABASE ────────────────────────────
 * `flushdb` erases a whole database, and every suite called it on the SAME one —
 * the same one the dev server uses. `redis://localhost:6380` selects database 0 by
 * default, which is what apps/api/.env points at, so a test run wiped the tenant
 * registry cache out from under a dev server somebody had open in another window.
 * The victim sees an app that breaks for no reason they did anything to cause, and
 * restarting the infrastructure does not obviously explain it.
 *
 * So every suite names itself and gets a private database. A flush now erases only
 * that suite's own state, which is what everyone already assumed it did. Database 0
 * is left to the dev server deliberately: it is the default, so it is what anything
 * unaware of this scheme connects to.
 *
 * ── WHAT THIS IS *NOT* ───────────────────────────────────────────────────────
 * It is not what fixed the wandering integration failures. That was a theory — that
 * parallel suites were flushing each other mid-test — and it was WRONG: the suites
 * run one file at a time (see vitest.config.ts), so they never raced here at all.
 * The real cause was Mailhog, which cannot be partitioned this way, plus a `vitest
 * run` invoked without `--no-file-parallelism`. Recorded because a comment that
 * takes credit for a fix it did not make is how the next person mis-diagnoses the
 * next outage.
 */
import { Redis } from "ioredis";

/** Local dev uses the docker compose redis on 6380 (default port is taken — PROJECT_MEMORY §8). */
const TEST_REDIS_BASE = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380";

/**
 * One private database per suite. Redis ships with 16 (0–15) and the compose file raises it to
 * 32 (`--databases 32`) — 0 belongs to the dev server, and the original fifteen were all claimed
 * by the time idempotency needed one. If a suite here fails with "DB index is out of range", the
 * local Redis predates that change: `pnpm docker:dev:down && pnpm docker:dev`.
 *
 * Assigned explicitly rather than hashed from the filename: a hash collision would
 * silently reintroduce exactly the cross-talk this exists to prevent, and would do
 * it as an intermittent failure in an unrelated suite months later. Here, a repeated
 * KEY is a compile error and a repeated VALUE trips the check below — both loud, at
 * the moment the mistake is made.
 */
const SUITE_DB = {
  auth: 1,
  appointments: 2,
  billing: 3,
  notifications: 4,
  encounters: 5,
  orders: 6,
  prescriptions: 7,
  rbac: 8,
  admissions: 9,
  registryCache: 10,
  allergies: 11,
  users: 12,
  patients: 13,
  lab: 14,
  /** Branch isolation (ADR-0015) — claimed from the spare pool, see the note above. */
  branchIsolation: 15,
  /** Idempotency-Key (Doc 04 §5.1) — the first suite past the stock 16-database ceiling. */
  idempotency: 16,
  /** The mobile contract suite — drives `@medicore/api-client` against the real app. */
  mobile: 17,
  /**
   * The clinic-clock suite (M0 §21 item C). Its own database because it moves a branch into a
   * far timezone, and a registry entry cached under another suite's key would hand that branch
   * back with the wrong zone — which is precisely the thing it exists to detect.
   */
  appointmentsTz: 18,
  /**
   * The MAR safety spine (M3-S1). Its own database because it moves a branch to America/New_York
   * to prove dose rounds resolve on the WARD's clock — a branch cached under another suite's key
   * would hand it back in the default zone and the timezone assertions would pass for the wrong
   * reason, which is the one outcome worse than failing.
   */
  mar: 19,
  /** Nursing documentation + allergy reach (M3-S2). Two branches and two tenants of its own. */
  nursing: 20,
  /**
   * Nurse vitals capture (M3-S4). Its own database because the idempotency assertions read the
   * key store directly: a replay claimed under another suite's key would report "one reading" for
   * the wrong reason, which is worse than failing.
   */
  vitals: 21,
} as const;

export type TestSuite = keyof typeof SUITE_DB;

/**
 * The two mistakes this file must never ship, checked where they'd be MADE — in the
 * map — rather than where they'd be used. Widened to `number[]` deliberately: the
 * literal types are narrow enough that TypeScript rejects these comparisons as
 * "unintentional", which is only true until someone edits the map above.
 */
const assigned: number[] = Object.values(SUITE_DB);
if (new Set(assigned).size !== assigned.length) {
  throw new Error("redisTestEnv: two suites share a Redis database — they will erase each other");
}
if (assigned.includes(0)) {
  throw new Error("redisTestEnv: database 0 belongs to the dev server — tests may not flush it");
}

/** The URL a suite must put in `process.env.REDIS_URL`. Points at its own database. */
export function testRedisUrl(suite: TestSuite): string {
  return `${TEST_REDIS_BASE}/${String(SUITE_DB[suite])}`;
}

export async function assertRedisReachable(): Promise<void> {
  const redis = new Redis(TEST_REDIS_BASE, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Integration tests require Redis at ${TEST_REDIS_BASE}.\n` +
        `Start it with: pnpm docker:dev  (or set REDIS_TEST_URL)\n` +
        `Underlying error: ${String(err)}`,
    );
  } finally {
    redis.disconnect();
  }
}

/**
 * Clears the CALLING SUITE'S cached state. Never anyone else's.
 *
 * REQUIRED, not hygiene: the tenant registry is a read-through cache, so a test
 * that drops the master database while `tenant:{slug}` is still cached will keep
 * resolving the tenant it just deleted, and the next run fails with a confusing
 * "slug already taken". Dropping Mongo without dropping Redis leaves the harness
 * in a state the application never produces on its own.
 */
export async function flushTestCache(suite: TestSuite): Promise<void> {
  // `flushdb` is destructive, and loopback does not prove the server is ours —
  // a tunnel or another project's container can hold the same local port (see
  // mongoTestEnv.assertLocalDevMongo, and PROJECT_MEMORY §8).
  const host = new URL(TEST_REDIS_BASE).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `REFUSING TO FLUSH: REDIS_TEST_URL points at a non-loopback host (${host}). ` +
        `Tests flush a whole database and may only do so against a local, disposable Redis.`,
    );
  }

  const db = SUITE_DB[suite];
  const redis = new Redis(TEST_REDIS_BASE, { lazyConnect: true, maxRetriesPerRequest: 1, db });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
