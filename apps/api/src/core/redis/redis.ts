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
} as const;

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
