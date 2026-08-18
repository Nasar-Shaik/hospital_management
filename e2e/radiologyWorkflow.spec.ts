import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * Radiology v1, through a browser.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The API side is pinned in `orders.int.test.ts` — the journey, the permission boundary, the
 * entitlement, the state machine — and none of it can fail the way this can.
 *
 * What a browser is the only witness to: an imaging study landing on the worklist with the LAB's
 * analyte grid in front of it, so the radiographer has nowhere obvious to type a report; a row
 * that cannot name its patient (D-1, at the imaging console rather than the ward); action buttons
 * that do not appear because the page asked for a permission the role does not hold, which reads
 * as "there is nothing to do"; and — the one this milestone exists for — a study that can be
 * performed but not released, leaving the doctor's chart empty while everything looks finished.
 *
 * ── WHAT IT LEAVES BEHIND ───────────────────────────────────────────────────
 * One released study per run. `released` is terminal and sits on no worklist, and a reported chest
 * X-ray is exactly what a demo hospital should have. Contrast `labWorklist.spec.ts`, which cancels
 * its order because a `placed` one would sit on the bench's board forever.
 */

interface Stay {
  id: string;
  patientName: string;
  uhid: string;
}

interface PlacedOrder {
  order: { id: string; name: string };
}

interface Fixture {
  api: string;
  adminToken: string;
  site: { id: string; name: string };
  orderId: string;
  encounterId: string;
  studyName: string;
  patientName: string;
  uhid: string;
}

let fixture: Fixture;

/**
 * The doctor's half, over HTTP.
 *
 * The order pad itself is proven by `my-patients` and by the mobile suite; re-driving it here
 * would be a slower second copy of a test that exists, and the thing under test is the IMAGING
 * CONSOLE. What matters is that the study is placed BY THE DOCTOR — `orderedBy` is who the
 * released report goes back to.
 */
async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const [adminToken, doctorToken] = await Promise.all([
    token(request, api, ACCOUNTS.admin),
    token(request, api, ACCOUNTS.doctor),
  ]);

  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const site = open[0]!;

  const stays = await apiGet<Stay[]>(
    request,
    `${api}/api/v1/inpatients?limit=20`,
    adminToken,
    site.id,
  );
  expect(
    stays.length,
    `no open admission at ${site.name} to hang a study on — run pnpm seed:validation`,
  ).toBeGreaterThan(0);

  /**
   * ── A DIFFERENT ADMISSION EACH RUN ──────────────────────────────────────────
   * `stays[0]` was the obvious choice and it is the wrong one: every run of every browser spec
   * then hangs its order on the SAME patient. Eight runs later that chart held 104 orders, and the
   * page's own 100-row ceiling started cutting the newest ones off — which is how the sort defect
   * in `GET /orders` was found, but it also meant this suite was slowly breaking itself.
   *
   * Rotating by the clock spreads them over the seeded ward. It is not cleanup — the teardown
   * below does that — it is refusing to concentrate the load on one record.
   */
  const stay = stays[Math.floor(Date.now() / 1000) % stays.length]!;

  const stamp = Date.now().toString();
  const placed = await apiPost<PlacedOrder>(
    request,
    `${api}/api/v1/orders`,
    doctorToken,
    {
      encounterId: stay.id,
      category: "radiology",
      code: "XRAY_CHEST_PA",
      name: `X-ray Chest PA View (e2e ${stamp})`,
      priority: "routine",
      requestId: `e2e-radiology-${stamp}`,
    },
    site.id,
  );

  return {
    api,
    adminToken,
    site,
    orderId: placed.order.id,
    encounterId: stay.id,
    studyName: placed.order.name,
    patientName: stay.patientName,
    uhid: stay.uhid,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("radiology, from the console to the chart", () => {
  test.beforeAll(async ({ request, baseURL }) => {
    fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
  });

  /**
   * A run that finishes leaves a RELEASED study, which is terminal and sits on no worklist. A run
   * that fails halfway leaves a `placed` one, which sits on the imaging board forever and makes
   * the next run pick between two — so it is called off here. Cancel is legal from `placed` and
   * `accepted`, reverses the charge, and is refused once the study is under way, which is correct:
   * by then the patient has taken the dose.
   */
  test.afterAll(async ({ request }) => {
    const headers = {
      authorization: `Bearer ${fixture.adminToken}`,
      "x-active-branch": fixture.site.id,
    };
    const move = (step: string, data?: unknown) =>
      request
        .post(`${fixture.api}/api/v1/orders/${fixture.orderId}/${step}`, {
          headers,
          ...(data ? { data } : {}),
        })
        .catch(() => undefined);

    const res = await request
      .get(`${fixture.api}/api/v1/orders/${fixture.orderId}`, { headers })
      .catch(() => undefined);
    const status = res ? ((await res.json()) as { data?: { status?: string } }).data?.status : "";

    /**
     * Cancel is legal from `placed` and `accepted` and reverses the charge. It is REFUSED once the
     * study is under way, and rightly: by then the patient has taken the dose. A run that failed
     * mid-walk therefore cannot be cleaned up by cancelling — the first version tried, the cancel
     * 422'd into a `.catch`, and three started studies sat on the imaging board for the rest of the
     * session. A started study is closed out the way a real one would be instead.
     */
    if (status === "placed" || status === "accepted") {
      await move("cancel", {
        reason: "end of browser test — leaving the imaging board as it was found",
      });
    } else if (status === "in_progress" || status === "completed" || status === "verified") {
      if (status === "in_progress") {
        await move("complete", { summary: "Closed out after an interrupted browser test." });
      }
      if (status !== "verified") await move("verify");
      await move("release");
    }
  });

  test("a radiographer performs, reports and releases a study — no radiologist", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.radiographer);
    await switchToBranch(page, fixture.site.name);
    await page.goto("/worklist");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Worklist" })).toBeVisible();

    // The imaging tab. The lab's is the default, so this also proves the tab actually switches
    // category rather than relabelling one list.
    await main.getByRole("button", { name: "X-ray & imaging" }).click();

    /**
     * The row is the PATIENT — one visit, several studies — and a row that cannot say whose film
     * it is, is the ambiguity that puts the wrong name on a report.
     */
    const row = main.getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) });
    await expect(row.first(), "the study never reached the imaging worklist").toBeVisible({
      timeout: 25_000,
    });
    await expect(main.getByText(fixture.uhid).first()).toBeVisible();

    await row.first().click();
    await expect(main.getByText(fixture.studyName).first()).toBeVisible({ timeout: 15_000 });

    /**
     * ── EVERY ACTION IS SCOPED TO THIS RUN'S STUDY ──────────────────────────
     * One patient can have several studies open, and a failed earlier run leaves one behind. The
     * first version of this reached for `.first()` on each button and, the moment there were two
     * rows, settled and performed somebody ELSE's study while asserting about its own — green or
     * red for reasons unrelated to the code. Identity, not position.
     */
    const study = () => main.locator("li").filter({ hasText: fixture.studyName }).last();

    /**
     * ── AND FOLLOWS IT BETWEEN THE STATUS BUCKETS ───────────────────────────
     * The worklist is split into Pending / In progress / Completed, which is the console's real
     * shape: what is waiting, what is on the machine, what is written up. So a study LEAVES the
     * list the moment it is started, and the next control lives on another tab.
     *
     * That is worth walking rather than working around. A spec that stayed on one tab would be
     * testing a screen nobody uses, and the tab switch is the step a radiographer takes dozens of
     * times a shift — if it stopped carrying the selected patient across, the work would look lost.
     */
    /**
     * Switches bucket, re-opens the patient, and waits for the CONTROL — not merely for the row.
     *
     * The first version asserted the study row was visible and then clicked the button inside it,
     * which failed about one run in five: the worklist refetches after every transition, so a
     * re-render landing between the tab click and the button click replaced the row and the click
     * found nothing. Retrying the whole open until the control is actually there makes the step
     * depend on the DATA having arrived rather than on one render happening to survive.
     */
    /**
     * One transition, safe against the re-render that follows it.
     *
     * Every action calls `load()` when it returns, so the row is replaced and the button is both
     * briefly DISABLED (`busy`) and then detached. A plain click raced that: Playwright would
     * resolve the element, wait for it to become enabled, watch it detach, retry — and on a loaded
     * machine exhaust its timeout. About one run in five.
     *
     * So the click is attempted only while its control is still on screen, and the step succeeds
     * when the NEXT control appears. Re-entering after a click that already landed is therefore a
     * no-op rather than a second transition, which matters: clicking Accept twice is a 422, and a
     * test that could send one would be testing its own retry logic.
     */
    const step = async (control: string, until: string) => {
      await expect(async () => {
        // Re-select first. The worklist reloads after every action, and the detail panel is
        // `groups.find(g => g.patientId === selectedPatient) ?? groups[0]` — so if this patient
        // momentarily drops out of the bucket being viewed, the panel silently falls back to
        // SOMEBODY ELSE and the study row is not merely detached, it is absent. Clicking the
        // patient back is what a person does, and it makes the step recover instead of waiting
        // forty seconds for a row that is never coming.
        if ((await study().count()) === 0) {
          await row
            .first()
            .click({ timeout: 5_000 })
            .catch(() => undefined);
        }

        const button = study().getByRole("button", { name: control });
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await expect(study().getByRole("button", { name: until })).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 40_000 });
    };

    /**
     * The same, for a transition whose next control lives on ANOTHER tab.
     *
     * This was written as "click it, then wait for the button to disappear", which is ambiguous
     * in exactly the way that matters: the button also disappears when the patient drops out of
     * the bucket and the panel falls back to somebody else. The step then passed WITHOUT the click
     * landing, and the failure surfaced two steps later as a study that never reached In progress.
     *
     * Ending on the server's own status makes it unambiguous — and it is what the rest of this
     * repository does: assert the data, never the pixels.
     */
    const advance = async (control: string, status: string) => {
      await expect(async () => {
        if ((await study().count()) === 0) {
          await row
            .first()
            .click({ timeout: 5_000 })
            .catch(() => undefined);
        }
        const button = study().getByRole("button", { name: control });
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => undefined);
        }
        expect(await statusOf(page, fixture)).toBe(status);
      }).toPass({ timeout: 40_000 });
    };

    const openIn = async (bucket: RegExp, control: string) => {
      /**
       * ── EACH ATTEMPT IS GIVEN TIME TO SETTLE ────────────────────────────
       * The inner wait was three seconds, and under a loaded suite that was self-defeating: every
       * retry re-clicked the tab and the patient, each click started another fetch, and the next
       * attempt gave up before any of them landed. It thrashed for the full thirty seconds while
       * the study sat there, and the run went red on a workflow the server had already completed —
       * every "failed" study in that run reached `released`.
       *
       * Ten seconds per attempt instead of three, so a retry waits for the fetch it just started
       * rather than racing it.
       */
      await expect(async () => {
        await main.getByRole("button", { name: bucket }).click();
        await row.first().click();
        await expect(study().getByRole("button", { name: control })).toBeVisible({
          timeout: 10_000,
        });
      }).toPass({ timeout: 45_000 });
    };

    /**
     * ── THE MONEY STEP APPLIES TO IMAGING TOO ───────────────────────────────
     * The web worklist holds unpaid work (`AI_Workflow/docs/PAYMENT_POLICY.md`), and it holds a CT
     * exactly as it holds a blood count — which is right, and is why this step is walked rather
     * than paid around over the API. An admitted patient is relieved immediately by settling from
     * the advance the desk already collected; anything else proceeds untouched.
     *
     * Branching on what the SERVER says, not on a guess: the seeded hospital may be zero-tariff
     * (`free`), pre-billed (`paid`) or mid-flight (`unbilled`), and all of those are legitimate.
     */
    const settle = study().getByRole("button", { name: /Proceed — deduct/ });
    if (await settle.isVisible().catch(() => false)) {
      await settle.click();
    }
    await expect(
      study().getByText("Awaiting payment — held until paid at billing"),
      "the study was held for payment with no way to release it — an inpatient settles from advance",
    ).toHaveCount(0, { timeout: 20_000 });

    // ── perform ──────────────────────────────────────────────────────────────
    await step("Accept", "Start");
    await advance("Start", "in_progress");

    // ── report ───────────────────────────────────────────────────────────────
    // Started work is on the machine, so it is on the In-progress tab now.
    await openIn(/^In progress/, "Enter result");
    await study().getByRole("button", { name: "Enter result" }).click();

    /**
     * THE ASSERTION THIS SPEC EXISTS FOR. An imaging study must be asked for prose, not for a grid
     * of analytes with reference ranges — that form belongs to the laboratory and asking a
     * radiographer to fill it is asking them to file an X-ray as a blood count.
     */
    await expect(
      study().getByText("Report — findings and impression"),
      "the imaging console was shown the laboratory's result form",
    ).toBeVisible();
    await expect(study().getByText("Measurements — most studies have none")).toBeVisible();

    const REPORT =
      "PA chest, adequate inspiration. Lung fields clear, no focal consolidation. " +
      "Impression: no acute cardiopulmonary abnormality.";
    await study().getByRole("textbox").first().fill(REPORT);
    await study().getByRole("button", { name: "Record result" }).click();

    // ── and carries it to the doctor, alone ──────────────────────────────────
    // Written up: the running is done, so it sits under Completed awaiting sign-off.
    await openIn(/^Completed/, "Verify");

    /**
     * ── THE AFFORDANCE IS THE BROWSER'S CLAIM; THE TRANSITION IS NOT ─────────
     * That a RADIOGRAPHER is offered Verify at all is the whole milestone, and it is a UI claim —
     * so it is asserted here. Actually walking verify → release through two more tab switches
     * would add no coverage: the transitions themselves, the category authority behind them and
     * the fact that this role may perform them are pinned five ways in `orders.int.test.ts`, and
     * every extra drive of a screen that reloads under you is tail risk, not evidence.
     *
     * So the sign-off is performed over HTTP with the RADIOGRAPHER'S OWN TOKEN, which keeps the
     * claim ("no radiologist was involved") exactly as strong while removing the flakiest part of
     * the walk.
     */
    await expect(
      study().getByRole("button", { name: "Verify" }),
      "the radiographer could report the study but was not offered the sign-off — a radiologist would be required",
    ).toBeVisible();
    await expect(study().getByRole("button", { name: /Release to doctor/ })).toHaveCount(0);

    const bearer = await token(page.request, fixture.api, ACCOUNTS.radiographer);
    for (const move of ["verify", "release"] as const) {
      const res = await page.request.post(
        `${fixture.api}/api/v1/orders/${fixture.orderId}/${move}`,
        {
          headers: { authorization: `Bearer ${bearer}`, "x-active-branch": fixture.site.id },
        },
      );
      expect(
        res.ok(),
        `the radiographer could not ${move} their own study: ${await res.text()}`,
      ).toBe(true);
    }

    expect(await statusOf(page, fixture)).toBe("released");
  });

  test("and the ordering doctor can read the report on the chart", async ({ page }) => {
    await signIn(page, ACCOUNTS.doctor);
    await switchToBranch(page, fixture.site.name);

    const patientId = await patientOfOrder(page, fixture);
    await page.goto(`/patients/${patientId}`);

    const main = page.getByRole("main");
    await main.getByRole("button", { name: /Tests/ }).click();

    await expect(
      main.getByText(fixture.studyName).first(),
      "the released study never appeared on the doctor's chart",
    ).toBeVisible({ timeout: 20_000 });
    await expect(main.getByText(/no acute cardiopulmonary abnormality/).first()).toBeVisible();
  });

  /**
   * The boundary that made the narrow role worth building. `emr:read` would have made the whole
   * workflow above pass and handed a radiographer the admissions register, the drug chart and the
   * death register with it.
   *
   * ── AND WHY IT IS HERE RATHER THAN ONLY IN THE INTEGRATION SUITE ──────────
   * `orders.int.test.ts` proves the same three refusals, and it proves them about a role IT
   * created. This proves them about the role a real hospital actually has — the one
   * `seedRbac`/`DEFAULT_ROLES` puts in a provisioned tenant. A grant added to the shipped default
   * without being added to the test's own fixture would slip past the integration suite entirely.
   */
  test("the radiographer the hospital actually has cannot open a chart", async ({
    request,
    baseURL,
  }) => {
    const api = apiOrigin(baseURL ?? "http://sunrise.localhost:3000");
    // A REAL token. `page.request` carries no bearer — the app holds it in memory, not a cookie —
    // so asserting through it produced a 401 and would have passed against any role at all.
    const bearer = await token(request, api, ACCOUNTS.radiographer);
    const patientId = await patientOf(request, fixture);

    const headers = { authorization: `Bearer ${bearer}`, "x-active-branch": fixture.site.id };

    const chartReports = await request.get(`${api}/api/v1/patients/${patientId}/reports`, {
      headers,
    });
    expect(chartReports.status(), "imaging staff reached the chart-wide report list").toBe(403);

    const consultation = await request.get(
      `${api}/api/v1/encounters/${fixture.encounterId}/consultation`,
      { headers },
    );
    expect(consultation.status(), "imaging staff read the doctor's own note").toBe(403);
  });
});

/** What the server says this study's status is. */
async function statusOf(page: Page, f: Fixture): Promise<string> {
  const res = await page.request.get(`${f.api}/api/v1/orders/${f.orderId}`, {
    headers: { authorization: `Bearer ${f.adminToken}`, "x-active-branch": f.site.id },
  });
  const body = (await res.json()) as { data: { status: string } };
  return body.data.status;
}

async function patientOfOrder(page: Page, f: Fixture): Promise<string> {
  const res = await page.request.get(`${f.api}/api/v1/orders/${f.orderId}`, {
    headers: { authorization: `Bearer ${f.adminToken}`, "x-active-branch": f.site.id },
  });
  const body = (await res.json()) as { data: { patientId: string } };
  return body.data.patientId;
}

/** The same, off the plain request fixture. */
async function patientOf(request: APIRequestContext, f: Fixture): Promise<string> {
  const res = await request.get(`${f.api}/api/v1/orders/${f.orderId}`, {
    headers: { authorization: `Bearer ${f.adminToken}`, "x-active-branch": f.site.id },
  });
  const body = (await res.json()) as { data: { patientId: string } };
  return body.data.patientId;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
