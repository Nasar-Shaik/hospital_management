/**
 * Vitest for the mobile foundation.
 *
 * ── WHY THESE TESTS NEED NO SIMULATOR ───────────────────────────────────────
 * Everything security-critical in M1 — the session lifecycle, branch restoration, permission
 * navigation, error mapping — lives in `src/lib`, which imports no React and no React Native. That
 * is a deliberate architectural boundary (see `src/platform/README` reasoning in
 * `src/lib/storage.ts`): the logic is testable in plain Node, so it runs in CI on a Linux box with
 * no Xcode, no Android SDK and no device. The React layer above it stays thin enough to review.
 *
 * The alias points `@medicore/api-client` at its SOURCE rather than its build output, for the same
 * reason `apps/api` does: the repository gate runs tests before `build`, so resolving to `dist/`
 * would test whatever was compiled last time — which is how a client change appears to pass.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@medicore/api-client": here("../../packages/api-client/src/index.ts"),
      "@": here("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    globals: false,
  },
});
