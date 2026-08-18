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
  const stay = stays[0]!;

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
    await request
      .post(`${fixture.api}/api/v1/orders/${fixture.orderId}/cancel`, {
        headers: {
          authorization: `Bearer ${fixture.adminToken}`,
          "x-active-branch": fixture.site.id,
        },
        data: { reason: "end of browser test — leaving the imaging board as it was found" },
      })
      .catch(() => undefined);
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
    const openIn = async (bucket: RegExp) => {
      await main.getByRole("button", { name: bucket }).click();
      await row.first().click();
      await expect(study()).toBeVisible({ timeout: 15_000 });
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
    await study().getByRole("button", { name: "Accept" }).click();
    await study().getByRole("button", { name: "Start" }).click();

    // ── report ───────────────────────────────────────────────────────────────
    // Started work is on the machine, so it is on the In-progress tab now.
    await openIn(/^In progress/);
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
    await openIn(/^Completed/);
    const verify = study().getByRole("button", { name: "Verify" });
    await expect(
      verify,
      "the radiographer could report the study but not sign it off — a radiologist would be required",
    ).toBeVisible({ timeout: 15_000 });
    await verify.click();

    const release = study().getByRole("button", { name: "Release to doctor" });
    await expect(release).toBeVisible({ timeout: 15_000 });
    await release.click();

    // The server is the truth, not the screen: a button that greys out without persisting looks
    // identical to a released study.
    await expect(async () => {
      expect(await statusOf(page, fixture)).toBe("released");
    }).toPass({ timeout: 20_000 });
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
