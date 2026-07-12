/**
 * Mongo connectivity for readiness checks (Doc 04 §8).
 * NOTE: this is NOT the Connection Manager — that is a P1 deliverable
 * (Doc 04 §2.2.1). Sprint 0 only proves the dependency is reachable.
 */
import mongoose from "mongoose";
import { env } from "../../config/env.js";

let connection: mongoose.Connection | undefined;

async function getConnection(): Promise<mongoose.Connection | undefined> {
  if (!env.MONGO_URI) return undefined;
  if (connection && connection.readyState === mongoose.ConnectionStates.connected) {
    return connection;
  }
  connection = await mongoose
    .createConnection(env.MONGO_URI, { serverSelectionTimeoutMS: 2000 })
    .asPromise();
  return connection;
}

export async function pingMongo(): Promise<"up" | "down"> {
  try {
    const conn = await getConnection();
    if (!conn?.db) return "down";
    await conn.db.admin().ping();
    return "up";
  } catch {
    return "down";
  }
}

export async function closeMongo(): Promise<void> {
  await connection?.close().catch(() => undefined);
  connection = undefined;
}
