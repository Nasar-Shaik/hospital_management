/**
 * Integration-test harness against a REAL MongoDB (Doc 05 §4.2).
 *
 * These tests must never silently skip: a skipped tenant-isolation suite looks
 * exactly like a passing one, and that suite is the thing standing between us
 * and a cross-tenant PHI leak (RISK_REGISTER T1). If Mongo is unreachable the
 * suite FAILS with instructions.
 */
import mongoose from "mongoose";

/**
 * Local dev uses the docker compose mongo on 27018 (infra/docker/docker-compose.yml).
 * `directConnection=true` is mandatory: the dev replica set advertises its member as
 * `localhost:27017`, so topology discovery would otherwise redirect us to whatever
 * else listens on host port 27017 (PROJECT_MEMORY §8).
 */
export const TEST_MONGO_URI =
  process.env.MONGO_TEST_URI ?? "mongodb://127.0.0.1:27018/?directConnection=true";

export async function assertMongoReachable(): Promise<void> {
  try {
    const conn = await mongoose
      .createConnection(TEST_MONGO_URI, { serverSelectionTimeoutMS: 3000 })
      .asPromise();
    await conn.db?.admin().ping();
    await conn.close();
  } catch (err) {
    throw new Error(
      `Integration tests require MongoDB at ${TEST_MONGO_URI}.\n` +
        `Start it with: pnpm docker:dev  (or set MONGO_TEST_URI)\n` +
        `Underlying error: ${String(err)}`,
    );
  }
}

/** Drops the databases a test created, so runs are repeatable. */
export async function dropDatabases(names: string[]): Promise<void> {
  const conn = await mongoose.createConnection(TEST_MONGO_URI).asPromise();
  for (const name of names) {
    await conn
      .useDb(name)
      .dropDatabase()
      .catch(() => undefined);
  }
  await conn.close();
}
