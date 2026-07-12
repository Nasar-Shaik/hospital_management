/**
 * Redis connectivity for readiness checks (Doc 04 §8, ADR-0006).
 * The governed keyspace client (CACHE_STRATEGY) lands in P1.
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

export async function pingRedis(): Promise<"up" | "down"> {
  try {
    const redis = getClient();
    if (!redis) return "down";
    if (redis.status === "wait" || redis.status === "end") await redis.connect();
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
