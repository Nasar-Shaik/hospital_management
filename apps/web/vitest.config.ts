import { defineConfig } from "vitest/config";

/**
 * Unit tests for the parts of the web app that are decisions rather than markup.
 *
 * There was no runner here at all, and the cost showed: `middleware.ts` documented that `/` is the
 * hospital's public website and then redirected every logged-out visitor away from it, for months,
 * with the contradiction sitting three lines apart in the same file. A comment cannot fail.
 *
 * ── MOSTLY NODE, DELIBERATELY — WITH ONE EXCEPTION THAT EARNED ITS DOM ──────
 * The house rule across this repository (see `apps/mobile/vitest.config.ts`) is that the decisions
 * are extracted out of the view layer and tested in plain Node, so CI needs no browser, no
 * simulator and no backend. That rule holds for everything here but one class of defect, and W-1
 * was it: "switching branch leaves the previous branch's rows on screen" is a statement about
 * MOUNTING, and no amount of extracted logic can prove a component went away. Asserting the fix by
 * grepping for a `key` prop would be testing the implementation and calling it evidence.
 *
 * So `.test.tsx` files run in jsdom and may render; `.test.ts` files stay in Node and may not. The
 * split is enforced by the file extension rather than by discipline, and the DOM stays confined to
 * the handful of components whose whole contract is what they mount and unmount.
 */
export default defineConfig({
  // The automatic runtime, matching `tsconfig`'s `jsx: preserve` + Next's compiler: the test files
  // import no `React` symbol, exactly as the components they exercise do not.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    environmentMatchGlobs: [["__tests__/**/*.test.tsx", "jsdom"]],
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    globals: false,
  },
});
