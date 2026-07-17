/**
 * Connection Manager — database-per-tenant core (Doc 04 §2.2.1, ADR-0005).
 *
 * Returns the Mongoose connection for a tenant's dedicated database
 * (`hms_<slug>`), caching connections in an LRU pool.
 *
 * Placement tiers (Doc 03 §1.5), all handled here so the rest of the app never
 * changes when a hospital is relocated:
 *   - co-located tenant  → `useDb` on the shared cluster connection (cheap: the
 *     underlying socket pool is shared)
 *   - dedicated tenant   → its own connection, from the registry's `dbUri`
 *
 * Guardrails (risk T3): hard cap on open connections with LRU eviction, plus an
 * idle sweep. Exceeding the cap evicts the least-recently-used idle connection
 * rather than exhausting the pool.
 */
import mongoose, { type Connection } from "mongoose";
import { env } from "../../config/env.js";
import { TenantUnavailableError } from "../errors/appError.js";

/** What the Connection Manager needs to know about a tenant (structural, not a Mongoose doc). */
export interface TenantConnectionTarget {
  id: string;
  databaseName: string;
  /** Dedicated server/cluster override; falls back to the shared cluster URI. */
  dbUri?: string;
}

interface PoolEntry {
  conn: Connection;
  lastUsed: number;
  /** Base cluster connections are shared via useDb; only dedicated ones are closed on evict. */
  dedicated: boolean;
}

const pool = new Map<string, PoolEntry>();
/** One base connection per cluster URI — co-located tenants all `useDb` off these. */
const baseConnections = new Map<string, Connection>();

async function getBaseConnection(uri: string): Promise<Connection> {
  const existing = baseConnections.get(uri);
  if (existing && existing.readyState === mongoose.ConnectionStates.connected) return existing;

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  baseConnections.set(uri, conn);
  return conn;
}

/** Evict the least-recently-used entry when the cap is reached. */
async function evictLru(): Promise<void> {
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of pool) {
    if (entry.lastUsed < oldestAt) {
      oldestAt = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) await evict(oldestKey);
}

async function evict(tenantId: string): Promise<void> {
  const entry = pool.get(tenantId);
  if (!entry) return;
  pool.delete(tenantId);
  // Only dedicated connections own a socket; useDb handles share the base connection.
  if (entry.dedicated) await entry.conn.close().catch(() => undefined);
}

/**
 * The one function that hands out tenant database connections.
 * Repositories reach this only through the request context — never directly.
 */
export async function getTenantConnection(tenant: TenantConnectionTarget): Promise<Connection> {
  const hit = pool.get(tenant.id);
  if (hit && hit.conn.readyState === mongoose.ConnectionStates.connected) {
    hit.lastUsed = Date.now();
    return hit.conn;
  }
  if (hit) await evict(tenant.id); // stale/disconnected — rebuild below

  if (!tenant.dbUri && !env.MONGO_URI) {
    throw new TenantUnavailableError({ reason: "no cluster URI configured" });
  }

  if (pool.size >= env.TENANT_MAX_CONNECTIONS) await evictLru();

  try {
    const dedicated = Boolean(tenant.dbUri);
    const baseUri = tenant.dbUri ?? (env.MONGO_URI as string);
    const base = await getBaseConnection(baseUri);
    const conn = base.useDb(tenant.databaseName, { useCache: true });

    pool.set(tenant.id, { conn, lastUsed: Date.now(), dedicated });
    return conn;
  } catch (err) {
    throw new TenantUnavailableError({ databaseName: tenant.databaseName, cause: String(err) });
  }
}

/** Idle sweep — releases connections unused for longer than the idle window. */
export async function sweepIdleConnections(now = Date.now()): Promise<number> {
  let swept = 0;
  for (const [tenantId, entry] of pool) {
    if (now - entry.lastUsed > env.TENANT_CONNECTION_IDLE_MS) {
      await evict(tenantId);
      swept += 1;
    }
  }
  return swept;
}

/** Observability hook (OBSERVABILITY_GUIDE: `hms_tenant_connections_open`). */
export function openConnectionCount(): number {
  return pool.size;
}

/** Test/ops helper: drop a tenant's cached connection (e.g. after a `dbUri` change). */
export async function releaseTenantConnection(tenantId: string): Promise<void> {
  await evict(tenantId);
}

/** Graceful shutdown (Doc 04 §2.3). */
export async function closeAllTenantConnections(): Promise<void> {
  for (const tenantId of [...pool.keys()]) await evict(tenantId);
  for (const [uri, conn] of baseConnections) {
    await conn.close().catch(() => undefined);
    baseConnections.delete(uri);
  }
}
