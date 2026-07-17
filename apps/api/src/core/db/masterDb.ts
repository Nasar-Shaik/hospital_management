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

/**
 * Cross-cluster safety net (dev). Confirms the server we actually reached is the
 * one we expect — see `MONGO_EXPECT_MEMBER`. Because every replica set is named
 * `rs0`, the driver alone cannot tell it has been redirected onto another
 * project's Mongo (an SSH tunnel or a colliding container on the same host port
 * is enough). This asks the server who it is and refuses anything else, so a
 * misconnection fails loudly at boot instead of reading — or worse, writing — a
 * stranger's database. A no-op unless `MONGO_EXPECT_MEMBER` is set.
 */
async function assertExpectedCluster(conn: Connection): Promise<void> {
  const expected = env.MONGO_EXPECT_MEMBER;
  if (!expected || !conn.db) return;
  const hello = (await conn.db.command({ hello: 1 })) as { me?: string; setName?: string };
  const me = hello.me ?? "(unknown)";
  if (me !== expected) {
    throw new Error(
      `Mongo identity check failed: connected to replica-set member "${me}" ` +
        `(set "${hello.setName ?? "standalone"}") but expected "${expected}". ` +
        `Another project's Mongo has likely taken this host port — a stray SSH tunnel or ` +
        `a second container. Free the port and retry; see infra/docker/LOCAL_PORTS.md.`,
    );
  }
}

/** Opens (once) and returns the master connection. Throws if MONGO_URI is unset. */
export async function getMasterConnection(): Promise<Connection> {
  if (masterConnection && masterConnection.readyState === mongoose.ConnectionStates.connected) {
    return masterConnection;
  }
  if (!env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured — master database is unavailable");
  }
  const conn = await mongoose
    .createConnection(env.MONGO_URI, {
      dbName: env.MONGO_MASTER_DB,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  // Validate BEFORE caching: a connection to the wrong cluster must never be reused.
  try {
    await assertExpectedCluster(conn);
  } catch (err) {
    await conn.close().catch(() => undefined);
    throw err;
  }
  masterConnection = conn;
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
