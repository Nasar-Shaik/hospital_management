import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests — the layer nothing else in this repository covers.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS SMALL ────────────────────────────────────
 * The API is proven at the integration layer: 1846 tests against a real Mongo, including branch
 * isolation, tenant isolation, the RBAC matrix, the clinical schema guards and two real HTTP
 * clients racing one dose. None of that needs a browser, and reproducing it here would buy
 * slower, flakier copies of tests that already exist.
 *
 * What no existing test covers is the BROWSER. Every one of the fifteen web suites runs in jsdom
 * with `fetch` mocked, so they prove a component renders what it is handed — never that the real
 * application, talking to the real API over real cookies, hands it the right thing. The defects
 * that live in that gap are exactly the ones the manual runbook was written for: a header naming
 * one site over another site's data, a permission-gated control that renders active, an identity
 * line that resolves to "—" for a patient nobody can find.
 *
 * So this suite is deliberately a critical path, not a mirror of the checklist.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * `workers: 1` — the suite writes to a shared seeded hospital, and two browsers charting the same
 * ward would be testing each other rather than the product.
 *
 * No `waitForTimeout` anywhere: every wait is on an application state (a URL, a row, a heading).
 * A sleep long enough to pass on this machine is a sleep that fails on a slower one, and the fix
 * is always a real condition rather than a bigger number.
 *
 * `TZ` is pinned for the same reason `vitest.config.ts` pins it: the branch's clock is the
 * product's clock, and a suite that inherits the developer's zone is a suite that passes here and
 * fails on a UTC runner.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",

  // One browser at a time against one seeded hospital. See the header.
  workers: 1,
  fullyParallel: false,

  /**
   * No retries. A browser test that passes on the second attempt is a test whose first result was
   * real evidence, and retrying it discards exactly the signal this suite exists to produce.
   */
  retries: 0,

  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    /**
     * The hostname IS the tenant (ADR-0005) — `sunrise.localhost` and `district.localhost` are two
     * different hospitals, so the base URL is a tenant selection and not a cosmetic default.
     */
    baseURL: process.env.E2E_BASE_URL ?? "http://sunrise.localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    timezoneId: "Asia/Kolkata",
  },

  /**
   * `preflight` runs first and everything else depends on it.
   *
   * The suite needs the hospital `seed:validation` builds — two open sites, patients in beds at
   * both, doses on the ward, the demo accounts. When that was checked inside the tests it was
   * checked with `test.skip`, which reports a missing environment as a PASS: the run went green
   * having never exercised branch isolation at all. As a dependency it fails once, says which
   * prerequisite is absent and how to restore it, and Playwright marks the rest not-run.
   */
  projects: [
    { name: "preflight", testMatch: /preflight\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["preflight"],
      testIgnore: /preflight\.setup\.ts$/,
    },
  ],

  /**
   * Starts the stack if it is not already up, so `pnpm test:e2e` works from a cold checkout and
   * does not silently test a stale server somebody left running yesterday. `reuseExistingServer`
   * keeps the developer's own `pnpm dev` when there is one — the 120s ceiling is Next's cold
   * compile, which is slow once and instant afterwards.
   */
  webServer: {
    command: "pnpm dev",
    /**
     * Wait on the WEB app, not the API.
     *
     * `pnpm dev` starts both, and the API answers `/health` in a couple of seconds while Next is
     * still compiling — so watching the API declares readiness far too early and every test then
     * burns its own timeout on a page that is not being served yet. Next only answers this route
     * once it has compiled it, and by then the API (which boots much faster) is long up.
     */
    url: "http://sunrise.localhost:3000/login",
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
