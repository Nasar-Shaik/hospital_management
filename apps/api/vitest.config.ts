import { defineConfig } from "vitest/config";

/**
 * The env loader is fail-fast (Doc 04 §2.3): a missing secret exits the process.
 * That is correct in production and fatal in a test runner, so tests get their
 * own throwaway secrets here. These values are non-secret by construction and
 * must never be used anywhere else.
 */
export default defineConfig({
  test: {
    env: {
      API_JWT_SECRET: "test-only-jwt-secret-not-for-any-real-environment-0123456789",
      // base64("test-only-encryption-key-32bytes") — exactly 32 bytes, as AES-256 requires.
      API_ENCRYPTION_KEY: "dGVzdC1vbmx5LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM=",
      LOGIN_LOCKOUT_MINUTES: "15",
    },
  },
});
