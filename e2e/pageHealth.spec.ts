import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ACCOUNTS, signIn } from "./support/app";

/**
 * The pages nothing had ever opened.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * TESTING.md §11 listed eleven screens with no coverage at ANY layer: not a browser test, not a
 * jsdom test, and — the runbook is honest about this — never a human either. They are the estate
 * registers and back-office surfaces: the disease register, the mortuary, theatres, the ambulance
 * board, assets, care packages, the tariff, feedback, the activity trail, the subscription and
 * reports.
 *
 * The cheap thing to do would have been eleven CRUD flows. That would be wrong twice over: the
 * writes are already proven at the integration layer against a real Mongo, and driving them
 * through a browser would leave rows behind in the shared seeded hospital, making this suite
 * order-dependent and its second run different from its first.
 *
 * What is genuinely unproven is narrower and much more interesting: **does the assembled
 * application, talking to the real API, load these pages at all?** Every jsdom suite hands
 * components a fixture the test author wrote, so a page can only render what the author believed
 * the API returns. Nothing checks the belief.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? THE ONE IT ALREADY CAUGHT ─────────────────
 * Writing this found two live defects of exactly one shape: a page asking the API for something it
 * refuses, and then rendering the refusal as ordinary emptiness.
 *
 *   · `/feedback` requested `users?limit=200`. The cap is 100, so every load was refused with
 *     `HMS-VAL-001` — and a `.catch()` written for the permission case turned that into an empty
 *     staff list. No complaint had ever shown who it was assigned to.
 *   · The patient chart requested `orders?limit=200` and got the same refusal, which `soft()`
 *     folded into an empty tab. A patient with three orders read **"Tests 0"** — a clinical record
 *     silently short of what the record actually holds.
 *
 * Neither is visible from below. The API is behaving correctly and its tests pass; the jsdom
 * suites mock `fetch` and never send the bad request. Only a browser against a real server can see
 * a page being told "no" and drawing a zero.
 *
 * So the assertion that earns this file is not "the heading is present" — it is **no unexpected
 * refusal, on any request the page made**. Expected refusals are declared below, each with the
 * reason, because a check that cannot distinguish a designed refusal from a bug is a check that
 * gets silenced within a month.
 */

/** A page under sweep, plus the one affordance that proves it rendered as more than a shell. */
interface Screen {
  path: string;
  heading: RegExp;
  /**
   * A control the signed-in role must be offered. This is the half that stops the sweep passing on
   * a page that loaded, refused everything quietly, and drew a read-only husk — and it pins the
   * permission STRING, which a typo turns into a control nobody is ever offered.
   */
  offers?: string;
  /** Requests this page is EXPECTED to be refused, and why. Anything else fails the test. */
  expectedRefusals?: { match: RegExp; because: string }[];
}

const SCREENS: Screen[] = [
  { path: "/mrd", heading: /Medical records/i, offers: "Add code" },
  {
    path: "/mortuary",
    heading: /Mortuary/i,
    offers: "Receive a body",
    expectedRefusals: [
      {
        match: /\/api\/v1\/mortuary/,
        /**
         * `module.support.mortuary` is not in PLAN_HOSPITAL, so the API answers `HMS-PLAN-002` and
         * the page says "Feature not in your edition" with a reference. That is the entitlement
         * gate working, and it is worth sweeping precisely because a plan refusal must read as an
         * explanation rather than as a blank register.
         */
        because: "the seeded plan does not include the mortuary module (HMS-PLAN-002)",
      },
    ],
  },
  { path: "/theatres", heading: /Operation theatres/i, offers: "Book a procedure" },
  { path: "/ambulance", heading: /Ambulance/i, offers: "Dispatch" },
  { path: "/assets", heading: /Assets/i, offers: "Add asset" },
  {
    path: "/packages",
    heading: /Care packages/i,
    expectedRefusals: [
      {
        match: /\/api\/v1\/packages/,
        /**
         * `module.finance.packages` is not in PLAN_HOSPITAL — care packages are a Day Care /
         * Hospital Plus differentiator — so the API answers `HMS-PLAN-002` and the page says so
         * instead of offering "Add package" over "No packages yet".
         *
         * Until 2026-08-20 these routes gated on `module.ops.opd` and this line read
         * `offers: "Add package"`, which is what the defect looked like from the browser: a
         * module the seeded hospital had not bought, working perfectly.
         */
        because: "the seeded plan does not include care packages (HMS-PLAN-002)",
      },
    ],
  },
  { path: "/tariff", heading: /Service tariff/i, offers: "Add service" },
  { path: "/feedback", heading: /Feedback & complaints/i, offers: "Log new" },
  { path: "/audit", heading: /Activity trail/i, offers: "Export CSV" },
  // Read-only by design — the plan is changed by PaperlessTech, not from here. No affordance.
  { path: "/subscription", heading: /Subscription & usage/i },
  { path: "/reports", heading: /Reports/i, offers: "Export CSV" },
];

/**
 * One browser, one sign-in, eleven navigations. Serial because they share it — and because a page
 * sweep has no reason to be parallel when the point is to visit each screen exactly once.
 */
test.describe.configure({ mode: "serial" });

test.describe("the back-office pages, loaded against the real API", () => {
  let page: Page;
  let watch: ApiWatch;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    watch = watchApi(page);
    // The administrator holds every permission these screens are gated on, so a refusal here is
    // never "this account may not" — it is the page or the request being wrong.
    await signIn(page, ACCOUNTS.admin);
  });

  test.afterAll(async () => {
    await page.close();
  });

  for (const screen of SCREENS) {
    test(`${screen.path} loads, and is refused nothing it did not expect`, async () => {
      watch.reset();
      await page.goto(screen.path, { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: screen.heading }).first()).toBeVisible({
        timeout: 30_000,
      });

      // Every request the page fired has come back. Only now is "what was refused?" a fair
      // question — asking earlier would pass by arriving before the answer did.
      await watch.settled();

      const unexpected = watch.failures.filter(
        (f) => !(screen.expectedRefusals ?? []).some((e) => e.match.test(f.url)),
      );
      expect(
        unexpected.map((f) => `${String(f.status)} ${f.code} ${short(f.url)}`),
        `${screen.path} was refused a request it did not expect — the page will be showing that ` +
          `refusal as ordinary emptiness`,
      ).toEqual([]);

      /**
       * An exception escaping React is invisible from the API and from jsdom-with-fixtures, and
       * leaves a half-drawn screen that still has its heading.
       */
      expect(watch.pageErrors, `${screen.path} threw while rendering`).toEqual([]);

      if (screen.offers) {
        await expect(
          page.getByRole("main").getByRole("button", { name: screen.offers }).first(),
          `${screen.path} did not offer "${screen.offers}" to an administrator who may use it`,
        ).toBeVisible({ timeout: 15_000 });
      }
    });
  }

  /**
   * The patient chart is not one of the eleven, but it is where the second defect lived — and a
   * fix with no test is a fix that comes back. Reached by CLICKING rather than by id, because the
   * seed recreates every patient and a hardcoded id is a test that expires.
   */
  test("the patient chart loads every strand of the record, refused nothing", async () => {
    watch.reset();
    await page.goto("/patients", { waitUntil: "domcontentloaded" });

    // The register is a table whose rows navigate on click — `.nth(1)` is the first PATIENT,
    // `.nth(0)` being the header row.
    const firstPatient = page.getByRole("main").getByRole("row").nth(1);
    await expect(
      firstPatient,
      "the register listed no patients — is the hospital seeded?",
    ).toBeVisible({ timeout: 30_000 });

    /**
     * ── THE CLICK IS RETRIED, AND THE GUARD IS THE URL ──────────────────────
     * A row can be visible a moment before the register's own load replaces the table, and a click
     * that lands in that gap hits a node that is being unmounted: nothing navigates, and the
     * failure reads as "the patient chart is broken" when the register simply re-rendered. Seen
     * once in roughly ten full-suite runs.
     *
     * The pathname check is what makes retrying safe. Without it, a click that DID navigate — just
     * slower than the inner timeout — would be followed by a second click on the chart page, on
     * whatever row `.nth(1)` happens to be there.
     */
    await expect(async () => {
      if (new URL(page.url()).pathname === "/patients") {
        await page.getByRole("main").getByRole("row").nth(1).click();
      }
      await expect(page).toHaveURL(/\/patients\/[a-f0-9]{8,}/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });

    await watch.settled();

    expect(
      watch.failures.map((f) => `${String(f.status)} ${f.code} ${short(f.url)}`),
      "a strand of the patient record was refused — `soft()` will be drawing it as empty",
    ).toEqual([]);
    expect(watch.pageErrors, "the patient chart threw while rendering").toEqual([]);
  });
});

/* ── watching what the page actually asked for ─────────────────────────────── */

interface Failure {
  status: number;
  code: string;
  url: string;
}

interface ApiWatch {
  failures: Failure[];
  pageErrors: string[];
  reset: () => void;
  settled: () => Promise<void>;
}

/**
 * Records every API call the page makes, and tells you when it has stopped making them.
 *
 * ── WHY QUIESCENCE AND NOT A SLEEP ──────────────────────────────────────────
 * The thing being waited for is "the page has finished asking" — which is a state of the
 * application, not a duration. Tracking requests in flight measures that state directly, so this
 * returns the instant the last response lands on a fast machine and still waits on a slow one.
 * A `waitForTimeout` tuned here would be a number that is too long every day and too short on the
 * day it matters.
 *
 * `networkidle` would be the built-in answer and is deliberately not used: it also counts the
 * document, the chunks and the fonts, so it reports on Next's dev compiler as much as on the
 * product, and it never settles at all on a page that keeps a connection open.
 */
function watchApi(page: Page): ApiWatch {
  const failures: Failure[] = [];
  const pageErrors: string[] = [];
  let inFlight = 0;
  let lastActivity = Date.now();

  const isApi = (url: string): boolean => /\/api\/v1\//.test(url);
  const touch = (): void => {
    lastActivity = Date.now();
  };

  page.on("request", (r) => {
    if (!isApi(r.url())) return;
    inFlight += 1;
    touch();
  });
  const done = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    touch();
  };
  page.on("requestfinished", (r) => {
    if (isApi(r.url())) done();
  });
  page.on("requestfailed", (r) => {
    if (isApi(r.url())) done();
  });

  page.on("response", (r) => {
    if (!isApi(r.url()) || r.status() < 400) return;
    void r
      .json()
      .then((b: unknown) => codeOf(b))
      .catch(() => "?")
      .then((code) => {
        failures.push({ status: r.status(), code, url: r.url() });
      });
  });

  page.on("pageerror", (e) => pageErrors.push(e.message));

  return {
    failures,
    pageErrors,
    reset() {
      failures.length = 0;
      pageErrors.length = 0;
      inFlight = 0;
      touch();
    },
    async settled() {
      /**
       * Quiet for a beat, not merely empty for an instant: a page that fires a follow-up request
       * from the first response would otherwise be declared finished in the gap between the two.
       */
      const QUIET_MS = 600;
      await expect
        .poll(() => inFlight === 0 && Date.now() - lastActivity >= QUIET_MS, {
          timeout: 30_000,
          message: "the page never stopped talking to the API",
        })
        .toBe(true);
    },
  };
}

/** The `HMS-…` code out of an error envelope, when the body is one. */
function codeOf(body: unknown): string {
  const err = (body as { error?: { code?: string } } | null)?.error;
  return err?.code ?? "?";
}

/** A URL short enough to read in a failure message, with the query kept — it is usually the bug. */
function short(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
