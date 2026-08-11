import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The env loader is fail-fast (Doc 04 §2.3): a missing secret exits the process.
 * That is correct in production and fatal in a test runner, so tests get their
 * own throwaway secrets here. These values are non-secret by construction and
 * must never be used anywhere else.
 */
export default defineConfig({
  /**
   * ── THE MOBILE SUITE IMPORTS THE CLIENT'S SOURCE, NOT ITS dist ─────────────
   * `mobileContract.int.test.ts` drives `@medicore/api-client` against the running app, and the
   * package's `main` points at `dist/`. Without this alias the suite would silently test whatever
   * was built LAST — and the release gate runs the tests before `pnpm build`, so a change to the
   * client would be verified against the previous version of itself.
   *
   * A stale-artifact test that passes is worse than one that fails: it certifies a contract that
   * is no longer the one being shipped. `pnpm build` and `typecheck` still compile the real
   * package, so the artefact is covered — just not by this suite, whose subject is the contract.
   */
  resolve: {
    alias: {
      "@medicore/api-client": fileURLToPath(
        new URL("../../packages/api-client/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    /**
     * ── SUITES RUN ONE AT A TIME, AND THE CONFIG DECIDES THAT — NOT THE CALLER ──
     * The integration suites share ONE Mongo, ONE Redis and ONE Mailhog. Mongo and
     * Redis are partitioned by naming (a database each). Mailhog CANNOT be: it has a
     * single inbox and a single "delete everything" button, so two suites sending mail
     * at once read each other's messages and clear each other's — and the symptom is
     * not an error, it is an assertion that finds two of something, or none, in
     * whichever suite lost the race. See test/mailTestEnv.ts.
     *
     * This lived only in the `test:int` script as `--no-file-parallelism`, and that
     * was the trap. A plain `vitest run` — the obvious thing to type, and what I typed
     * for three sessions — silently ran them in parallel and produced failures that
     * looked like a real, wandering bug in the notification dedupe. Time went into
     * hunting a race in the product; the race was in the harness invocation.
     *
     * A test suite whose correctness depends on remembering a CLI flag WILL be run
     * without the flag, and the punishment is not a clear error but a plausible lie.
     * So the guarantee moves here, where it holds for every way of running these
     * tests. The flag stays in the script: harmless, and it documents the intent at
     * the call site.
     *
     * The cost is wall-clock time on the unit tests, which is a few seconds.
     */
    fileParallelism: false,

    /**
     * ── WHY 20s AND NOT VITEST'S 5s ──────────────────────────────────────────
     * These suites talk to a REAL Mongo in Docker. A single login is ~8 sequential
     * round trips (user, credential, attempt, clear-failures, record-login, audit,
     * token), and a cold index build or a disk flush can stall any one of them for
     * seconds. 5s is the default for unit tests that touch nothing.
     *
     * This is NOT the password hash: measured, argon2id at our parameters costs 18ms
     * to hash and 17ms to verify on this machine. I assumed hashing was the culprit
     * and was wrong — recorded so the next person does not re-guess it.
     *
     * It is not credited with fixing anything, either: the timeouts that prompted it
     * were seen under accidental parallelism, and `fileParallelism: false` is what
     * addressed those. This stays because 5s is simply the wrong budget for a test
     * that waits on Docker, and a too-tight timeout fails as a mystery rather than as
     * a diagnosis.
     */
    testTimeout: 20_000,

    env: {
      API_JWT_SECRET: "test-only-jwt-secret-not-for-any-real-environment-0123456789",
      // base64("test-only-encryption-key-32bytes") — exactly 32 bytes, as AES-256 requires.
      API_ENCRYPTION_KEY: "dGVzdC1vbmx5LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM=",
      LOGIN_LOCKOUT_MINUTES: "15",

      /**
       * ── THE SUITE MUST NOT INHERIT THE MACHINE'S TIMEZONE ────────────────────
       * Found by running the release gate on a UTC machine for the first time —
       * which is what every CI runner and every container is, and what no
       * developer here has been. One test failed:
       *
       *   notifications › "renders the time in the hospital's timezone, not UTC"
       *   expected 'Dear Meera Nair…' to match /09:15\s*(am|AM)/
       *
       * The suite builds appointment times with `d.setHours(9, 15)`, which means
       * 09:15 IN WHATEVER ZONE THE MACHINE IS SET TO. On a developer's machine
       * that is Asia/Kolkata and the rendered mail says 09:15; on a UTC machine
       * the same call produces a different instant and the mail says 02:45 pm.
       * A green suite was therefore a property of the laptop, not of the code.
       *
       * Pinned here rather than in `test:int`, for the same reason
       * `fileParallelism` is pinned here: a guarantee that depends on remembering
       * a CLI flag is a guarantee you do not have.
       *
       * ── WHY Asia/Kolkata AND NOT UTC ─────────────────────────────────────────
       * Because it is the zone the PRODUCT already assumes, and pinning it keeps
       * this change to the test harness. `appointment.service.ts` resolves a
       * doctor's session with `startAt.getDay()` and slot arithmetic in the
       * PROCESS zone, while `appointment.consumers.ts` renders the patient's mail
       * in `env.DEFAULT_TIMEZONE`. Those two agree only when the process zone IS
       * the hospital's zone — an assumption nothing in the deployment enforces:
       * no Dockerfile, compose file or `.env.example` sets `TZ`, so the shipped
       * image runs UTC. There, a clinic's "Monday 09:00" session is offered at
       * 09:00 UTC and the patient is emailed "02:45 pm".
       *
       * That is a product defect, not a test defect, and it is deliberately NOT
       * fixed here: the correct zone for a session is a design decision (tenant
       * default, or the branch's own zone — `branch.model.ts` allows a branch to
       * sit in a different one), and it belongs in a milestone with its own
       * tests. Recorded in PROJECT-STATUS.md. Pinning IST reproduces today's
       * behaviour deterministically on every machine; it does not endorse it.
       */
      TZ: "Asia/Kolkata",
    },
  },
});
