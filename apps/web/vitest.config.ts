import { defineConfig } from "vitest/config";

/**
 * Unit tests for the parts of the web app that are decisions rather than markup.
 *
 * There was no runner here at all, and the cost showed: `middleware.ts` documented that `/` is the
 * hospital's public website and then redirected every logged-out visitor away from it, for months,
 * with the contradiction sitting three lines apart in the same file. A comment cannot fail.
 *
 * Deliberately NOT a component-rendering setup. Rendering React Server Components that fetch from
 * the API needs a browser environment and a running backend, which is what the Playwright suite is
 * for. This runs in plain Node, in milliseconds, over logic extracted to be callable.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    globals: false,
  },
});
