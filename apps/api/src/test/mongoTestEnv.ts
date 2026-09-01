/**
 * Integration-test harness against a REAL MongoDB (Doc 05 §4.2).
 *
 * These tests must never silently skip: a skipped tenant-isolation suite looks
 * exactly like a passing one, and that suite is the thing standing between us
 * and a cross-tenant PHI leak (RISK_REGISTER T1). If Mongo is unreachable the
 * suite FAILS with instructions.
 *
 * It must also never DROP A DATABASE IT DOES NOT OWN. This harness runs
 * `dropDatabase()`, so "which server am I actually talking to?" is a safety
 * question, not a curiosity — see `assertLocalDevMongo` below.
 */
import mongoose from "mongoose";

/**
 * Local dev uses the docker compose mongo on 37018 (infra/docker/docker-compose.yml) —
 * a port nothing else on the dev machine uses — with a replica set named `hms0`, not the
 * conventional `rs0`. It listens on 37018 INSIDE the container too and advertises
 * `localhost:37018`, so replica-set discovery resolves back to the same server and cannot
 * redirect this harness to an unrelated Mongo. `directConnection=true` is kept as the
 * second lock: it skips discovery entirely. That matters here more than anywhere else in
 * the codebase, because this harness calls `dropDatabase()` (PROJECT_MEMORY §8).
 */
export const TEST_MONGO_URI =
  process.env.MONGO_TEST_URI ?? "mongodb://127.0.0.1:37018/?directConnection=true";

/**
 * The ONLY database names this harness may destroy. Anything else is somebody
 * else's data by definition, and dropping it is never the right move — not even
 * when a test "obviously" created it.
 */
const DROPPABLE = /^(test_|hms_test-)/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostOf(uri: string): string {
  // mongodb://[user:pass@]host:port/... — we only need the host.
  const authority = uri.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0] ?? "";
  const hostPort = authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
  return (hostPort.split(",")[0] ?? "").replace(/:\d+$/, "");
}

/**
 * Proves we are pointed at the throwaway dev MongoDB before anything destructive runs.
 *
 * This exists because of a real near-miss: an SSH tunnel
 * (`ssh -L 27018:127.0.0.1:27017 user@remote`) bound the SAME loopback port our
 * dev database uses, and silently won the bind over Docker. Every connection to
 * `127.0.0.1:27018` was then reaching a REMOTE server — and this harness drops
 * databases. A loopback address is not proof of a local database.
 *
 * Two independent checks, both cheap:
 *   1. the host is loopback (never run this against a remote host, ever);
 *   2. the server has NO authentication — our dev container runs open, and every
 *      real deployment does not. A server that demands credentials is, by
 *      definition, not our disposable dev container.
 *
 * Fails closed with instructions. It is far better to block a test run than to
 * drop a database that belongs to someone else.
 */
function assertLoopback(): void {
  const host = hostOf(TEST_MONGO_URI);
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `REFUSING TO RUN: integration tests drop databases, and MONGO_TEST_URI points at a non-loopback host (${host}).\n` +
        `They may only run against a local, disposable MongoDB.`,
    );
  }
}

export async function assertLocalDevMongo(): Promise<void> {
  assertLoopback();

  const conn = await mongoose
    .createConnection(TEST_MONGO_URI, { serverSelectionTimeoutMS: 3000 })
    .asPromise();
  try {
    // Our dev container has auth disabled. If this is refused, we are talking to
    // a real server — through a tunnel, or another container that grabbed the port.
    await conn.db?.admin().listDatabases();
  } catch (err) {
    const unauthorized =
      err instanceof Error && /auth|unauthorized|not authorized/i.test(err.message);
    if (unauthorized) {
      throw new Error(
        `REFUSING TO RUN: something on ${TEST_MONGO_URI} requires authentication, so it is NOT the local dev MongoDB —\n` +
          `these tests drop databases and will not do that to a server they cannot identify.\n\n` +
          `Most likely cause: another process has taken port ${TEST_MONGO_URI.replace(/.*:(\d+).*/, "$1")} on loopback —\n` +
          `  • an SSH tunnel:      lsof -nP -iTCP:37018 -sTCP:LISTEN\n` +
          `  • another project's container: docker ps\n` +
          `A loopback address does NOT prove the database is local (PROJECT_MEMORY §8).`,
      );
    }
    throw err;
  } finally {
    await conn.close();
  }
}

export async function assertMongoReachable(): Promise<void> {
  // Loopback is checked BEFORE we open a socket: the dangerous case is a remote
  // that answers, not one that times out.
  assertLoopback();

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
  await assertLocalDevMongo();
}

/** Drops the databases a test created, so runs are repeatable. */
export async function dropDatabases(names: string[]): Promise<void> {
  const forbidden = names.filter((n) => !DROPPABLE.test(n));
  if (forbidden.length > 0) {
    throw new Error(
      `REFUSING TO DROP: ${forbidden.join(", ")} — test databases must be named ` +
        `test_* or hms_test-*. This guard is what stops a stray name from destroying real data.`,
    );
  }

  const conn = await mongoose.createConnection(TEST_MONGO_URI).asPromise();
  for (const name of names) {
    await conn
      .useDb(name)
      .dropDatabase()
      .catch(() => undefined);
    await writable(conn, name);
  }
  await conn.close();
}

/**
 * Blocks until a just-dropped database can be WRITTEN to again.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * `dropDatabase()` resolving does not mean the server has finished. Under load — the full
 * integration run keeps twenty-odd test databases alive and MongoDB busy — the namespace stays in
 * a dropping state for a while afterwards, and the very next thing every suite does is provision a
 * tenant into it. That fails with:
 *
 *   MongoServerError: Cannot create collection hms_test-…-rival.wardNotes
 *                     - database is in the process of being dropped.
 *
 * thrown from a migration inside `provisionTenant` inside `beforeAll` — so the whole FILE is
 * reported as a failed suite and every test in it is skipped, with a message that reads like a
 * migration bug. Seen once in three full runs on 2026-08-19; the shape (a `beforeAll` that dies on
 * a database operation, in a different suite each time) also matches the hook timeouts recorded
 * during the T3 investigation.
 *
 * ── WHY THE PROBE IS A WRITE ────────────────────────────────────────────────
 * Reads succeed against a database that is still being dropped, so `listCollections` or
 * `listDatabases` would answer "fine" and prove nothing. The precondition every caller actually
 * needs is "I can create a collection here", so that is what is tested. The probe is removed
 * again, leaving the database as empty as the drop intended.
 */
async function writable(conn: mongoose.Connection, name: string): Promise<void> {
  const PROBE = "__drop_settled_probe";
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await conn.useDb(name).createCollection(PROBE);
      await conn
        .useDb(name)
        .dropCollection(PROBE)
        .catch(() => undefined);
      return;
    } catch (err) {
      // Anything other than the drop still running is a real problem and must not be swallowed —
      // an unreachable server would otherwise spin here for thirty seconds and then lie about why.
      if (!/being dropped/i.test(String(err))) throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `${name} was still being dropped after 30s. Mongo is either wedged or far slower than ` +
            `this host has ever been; do not raise this timeout without finding out which.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
