/**
 * Master database connection — `paperlesstech_master` (Doc 03 §1.1).
 *
 * BOUNDARY (Doc 04 §2.2.1): master DB access is confined to this module and the
 * platform modules (tenants, subscriptions, feature flags, licensing, SaaS
 * billing, support). **Business modules must never import this** — they receive
 * a tenant connection from the request context only.
 *
 * The master DB holds platform data ONLY. Never PHI, never hospital data.
 */
import mongoose, { type Connection } from "mongoose";
import { env } from "../../config/env.js";

let masterConnection: Connection | undefined;

/** Opens (once) and returns the master connection. Throws if MONGO_URI is unset. */
export async function getMasterConnection(): Promise<Connection> {
  if (masterConnection && masterConnection.readyState === mongoose.ConnectionStates.connected) {
    return masterConnection;
  }
  if (!env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured — master database is unavailable");
  }
  masterConnection = await mongoose
    .createConnection(env.MONGO_URI, {
      dbName: env.MONGO_MASTER_DB,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  return masterConnection;
}

/** Readiness probe (Doc 04 §8). Never throws. */
export async function pingMaster(): Promise<"up" | "down"> {
  try {
    const conn = await getMasterConnection();
    if (!conn.db) return "down";
    await conn.db.admin().ping();
    return "up";
  } catch {
    return "down";
  }
}

export async function closeMaster(): Promise<void> {
  await masterConnection?.close().catch(() => undefined);
  masterConnection = undefined;
}
