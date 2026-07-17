/**
 * Redis client + governed cache keyspace (ADR-0006, CACHE_STRATEGY).
 *
 * Redis is NEVER a source of truth: everything here is rebuildable from Mongo.
 * A Redis outage degrades latency, not correctness — cache helpers fail soft and
 * callers fall through to the database (DR runbook §1).
 *
 * Every key pattern MUST be registered in AI_Workflow/docs/CACHE_STRATEGY.md.
 */
import { Redis } from "ioredis";
import { env } from "../../config/env.js";

let client: Redis | undefined;

function getClient(): Redis | undefined {
  if (!env.REDIS_URL) return undefined;
  client ??= new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  return client;
}

async function connected(): Promise<Redis | undefined> {
  const redis = getClient();
  if (!redis) return undefined;
  if (redis.status === "wait" || redis.status === "end") {
    await redis.connect().catch(() => undefined);
  }
  return redis.status === "ready" ? redis : undefined;
}

/** Cache-key builders — the ONLY place key patterns are constructed. */
export const cacheKeys = {
  /** Registry lookup by slug (CACHE_STRATEGY: TTL 5 min). */
  tenantBySlug: (slug: string) => `tenant:${slug}`,
  /** Registry lookup by custom domain host (CACHE_STRATEGY: TTL 5 min). */
  tenantByDomain: (host: string) => `tenant:domain:${host}`,
  /**
   * Access-token blocklist (CACHE_STRATEGY: `revoked:{jti}`, TTL = the token's
   * own remaining life, so entries expire exactly when they stop mattering).
   * Written on logout; read by `authenticate`.
   */
  revokedToken: (jti: string) => `revoked:${jti}`,
  /**
   * The authorization bundle — permissions + branch scope (CACHE_STRATEGY:
   * `perm:{userId}`, TTL = access-token life). Read on every authorized request;
   * invalidated explicitly by whoever changes a role or a binding.
   *
   * ── THE `v2` IS LOAD-BEARING. BUMP IT WHENEVER THE BUNDLE'S SHAPE CHANGES. ──
   * A cached bundle outlives a deploy. When `allBranches` was added to the bundle
   * (P2), every entry already in Redis lacked the field — and the new code reads a
   * missing `allBranches` as `false`, which means "confined to no branches", which
   * means every user in every hospital would have seen an EMPTY PATIENT LIST for
   * up to a full TTL after the release, then silently started working. A bug that
   * heals itself in fifteen minutes is one nobody can reproduce and everybody
   * remembers.
   *
   * Versioning the key sidesteps the whole class: old-shaped entries are simply
   * never read again, and they expire on their own. This is cheaper and safer than
   * a migration, because the cache is not a source of truth — it can be abandoned.
   */
  userPermissions: (userId: string) => `perm:v2:${userId}`,
  /**
   * Entitlement bundle — the tenant's enabled feature flags (CACHE_STRATEGY:
   * `ff:{tenantId}`, TTL 5 min). Invalidated on a plan or flag change.
   */
  tenantFeatures: (tenantId: string) => `ff:${tenantId}`,
  /**
   * Leader election for singleton background loops (CACHE_STRATEGY: `lock:{name}`).
   * Every API pod runs the outbox relay; exactly one of them may relay at a time.
   */
  lock: (name: string) => `lock:${name}`,
} as const;

/**
 * Best-effort mutual exclusion for background loops.
 *
 * This is NOT a correctness primitive and must never be used as one. Redlock's
 * own authors are clear that a single-node lock can be lost to a GC pause or a
 * failover, so two holders can briefly coexist. It is used here only to stop N
 * API pods from doing the same relay work N times — and the relay is safe under
 * concurrency anyway (`claimDue` is an atomic compare-and-set, and consumers are
 * idempotent). The lock is an efficiency measure, not the thing that keeps the
 * system correct. Never guard money or PHI with it.
 *
 * Returns false when Redis is unavailable: no lock, no leadership, no relay —
 * the events simply stay in the outbox until Redis returns, which is exactly
 * what a durable outbox is for.
 */
export async function acquireLock(name: string, ttlMs: number, holder: string): Promise<boolean> {
  try {
    const redis = await connected();
    if (!redis) return false;
    const result = await redis.set(cacheKeys.lock(name), holder, "PX", ttlMs, "NX");
    return result === "OK";
  } catch {
    return false;
  }
}

/**
 * Extends a lock we already hold. The Lua script makes "check owner" and "extend"
 * one atomic step — the check-then-extend version can renew a lock that expired
 * and was taken by someone else in between, which is the classic way a leader
 * election quietly elects two leaders.
 */
export async function renewLock(name: string, ttlMs: number, holder: string): Promise<boolean> {
  try {
    const redis = await connected();
    if (!redis) return false;
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
    const result = await redis.eval(script, 1, cacheKeys.lock(name), holder, String(ttlMs));
    return result === 1;
  } catch {
    return false;
  }
}

/** Releases only if we still hold it — same reason as above. */
export async function releaseLock(name: string, holder: string): Promise<void> {
  try {
    const redis = await connected();
    if (!redis) return;
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await redis.eval(script, 1, cacheKeys.lock(name), holder);
  } catch {
    /* the TTL will clean it up */
  }
}

/** Read-through cache get. Returns undefined on miss OR on any Redis failure (fail soft). */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const redis = await connected();
    if (!redis) return undefined;
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Cache set with mandatory TTL (CACHE_STRATEGY: no immortal keys). Fails soft. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    const redis = await connected();
    if (!redis) return;
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* cache write failures never break a request */
  }
}

/** Explicit invalidation — called by the writer of the source data, in the same service method. */
export async function cacheDel(...keys: string[]): Promise<void> {
  try {
    const redis = await connected();
    if (!redis || keys.length === 0) return;
    await redis.del(...keys);
  } catch {
    /* fail soft */
  }
}

export async function pingRedis(): Promise<"up" | "down"> {
  try {
    const redis = await connected();
    if (!redis) return "down";
    const pong = await redis.ping();
    return pong === "PONG" ? "up" : "down";
  } catch {
    return "down";
  }
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = undefined;
}
