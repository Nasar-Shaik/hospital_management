import { defineConfig } from "vitest/config";

/**
 * The env loader is fail-fast (Doc 04 §2.3): a missing secret exits the process.
 * That is correct in production and fatal in a test runner, so tests get their
 * own throwaway secrets here. These values are non-secret by construction and
 * must never be used anywhere else.
 */
export default defineConfig({
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
    },
  },
});
