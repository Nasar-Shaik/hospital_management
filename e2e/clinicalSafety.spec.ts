import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ACCOUNTS, branchNames, signIn, switchToBranch } from "./support/app";

/**
 * The dose rows on the medication round.
 *
 * Selected by the drugs `seed:validation` puts on the ward, because the row's accessible name is
 * the drug, its dose and its scheduled time. The row is deliberately a NAVIGATION control rather
 * than an action — the page's own comment explains that a button a nurse believes administers a
 * drug is an inline administration whatever the code does — so "may this person chart?" shows up
 * here as whether the row is enabled.
 */
function doseRows(page: Page): Locator {
  return page
    .getByRole("main")
    .getByRole("button", { name: /Paracetamol|Pantoprazole|Metformin|Amlodipine|Cetirizine/i });
}

/**
 * The two rows the runbook says were fixed and then "never opened in a browser".
 *
 * Both are safety, not cosmetics, and both are invisible to every other layer of the pyramid: the
 * API returns correct data in each case, and the jsdom suites hand components correct props. What
 * is unproven is what the assembled application actually puts in front of a nurse.
 */

test.describe("the medication round, as a viewer who may not chart", () => {
  /**
   * WEB-19 / PERM-09 — a doctor RECONCILING what a patient received is a legitimate reader, so the
   * round renders for `emr:read`. The boundary that matters is the WRITE.
   *
   * WHAT DEFECT WOULD THIS CATCH?
   * A doctor able to chart a dose from the round. `mar:administer` is deliberately nurse-only —
   * the second pair of eyes is the entire safety argument — and a UI that lets a doctor press Give
   * is a P1 even though the API would refuse it, because the refusal arrives after the drug has
   * been handed over.
   *
   * The API half is already pinned by the RBAC matrix; this is the half about what is on screen.
   */
  test("shows the doctor the round, with every dose action inert", async ({ page }) => {
    await signIn(page, ACCOUNTS.doctor);
    await page.goto("/medication-round");

    // It RENDERS — refusing a reader would be the opposite defect, and is also wrong.
    await expect(page.getByRole("heading", { name: /medication round/i })).toBeVisible();

    /**
     * The dose rows must EXIST and every one of them must be disabled. Both halves matter: a
     * version of this that only checked "nothing enabled" would pass just as happily on a page
     * that rendered no doses at all, which is a broken round rather than a working permission.
     */
    await expect(async () => {
      const doses = doseRows(page);
      const total = await doses.count();
      expect(total, "the doctor's round rendered no dose rows — nothing to prove").toBeGreaterThan(
        0,
      );

      for (let i = 0; i < total; i++) {
        await expect(doses.nth(i), "a doctor was offered a live dose row").toBeDisabled();
      }
    }).toPass({ timeout: 25_000 });
  });

  test("offers the nurse a live control on the same screen", async ({ page }) => {
    /**
     * The control. Without it, the test above would pass on a page that renders no actions for
     * ANYONE — proving the round is broken rather than that permissions work.
     */
    await signIn(page, ACCOUNTS.nurse);
    // One site, not All-branches: the round is a ward round, and `preflight.setup.ts` has already
    // proved this site has doses scheduled today.
    const sites = await branchNames(page);
    expect(sites.length, "the switcher offered no site to work in").toBeGreaterThan(0);
    await switchToBranch(page, sites[0] as string);
    await page.goto("/medication-round");

    await expect(page.getByRole("heading", { name: /medication round/i })).toBeVisible();

    await expect(async () => {
      const live = doseRows(page).and(page.locator("button:not([disabled])"));
      expect(
        await live.count(),
        "the nurse was offered no live dose row — the doctor test above would prove nothing",
      ).toBeGreaterThan(0);
    }).toPass({ timeout: 25_000 });
  });
});

test.describe("patient identity on the surfaces a nurse reads before giving a drug", () => {
  /**
   * WEB-04 / WEB-05 / FR-02 — web defect D-1.
   *
   * WHAT DEFECT WOULD THIS CATCH?
   * The exact regression `375e4cf` fixed and that the runbook says has never since been seen in a
   * browser: the ward rebuilt patient names client-side from the hundred most recent
   * registrations, so a long-stay patient — admitted before that window — rendered as
   * `Patient: —`. Right patient, blank. The first of the five rights, missing at the moment of
   * administration.
   *
   * `seed:validation` builds this case on purpose: bed GW-1 is registered FIRST, out of the
   * hundred-most-recent window, with 127 patients registered in total.
   */
  test("names every admitted patient on the ward, and gives the chart a UHID", async ({ page }) => {
    await signIn(page, ACCOUNTS.nurse);
    // One site, not All-branches: a ward belongs to a site, and an aggregate ward list is a
    // different screen from the one a nurse works from.
    const sites = await branchNames(page);
    expect(sites.length, "the switcher offered no site to work in").toBeGreaterThan(0);
    await switchToBranch(page, sites[0] as string);
    await page.goto("/ward");

    const list = page.getByRole("main").getByRole("list").first();
    await expect(list.getByRole("button").first()).toBeVisible({ timeout: 25_000 });

    /**
     * Every row, not a sample. D-1 struck exactly the patients a sample would miss — the oldest
     * admissions, which sort last and are the ones a hundred-record window excludes.
     */
    const rows = await list.getByRole("button").allInnerTexts();
    expect(rows.length, "no ward rows rendered").toBeGreaterThan(0);
    for (const row of rows) {
      const name = (row.split("\n")[0] ?? "").trim();
      expect(name, `a ward row rendered "${name}" where a patient's name belongs`).not.toMatch(
        /^(—|-|)$/,
      );
    }

    /**
     * ── WEB-04, DECIDED ─────────────────────────────────────────────────────
     * The runbook row reads "Name + UHID on every row" of the ward. The implementation puts the
     * name on the row and the UHID on the chart the row opens.
     *
     * That is the correct behaviour, and the runbook row is over-specified. §9 scopes the five
     * rights to "every ADMINISTERING surface … the confirmation screen a nurse reads at the moment
     * of giving" — and the ward list is not one: no drug can be given from it. It is a navigation
     * rail beside a patient panel, and the panel carries both identifiers. The surfaces that ARE
     * administering — the medication round and its confirmation — carry name and UHID on the row
     * itself, which the next test pins.
     *
     * So this asserts what the product guarantees, the runbook has been amended to say where the
     * requirement applies, and no production code was changed to satisfy a test.
     */
    await list.getByRole("button").first().click();
    await expect(page.getByRole("main")).toContainText(/UH-?\d+/i, { timeout: 15_000 });
  });

  /**
   * FR-02 / WEB-05 — the administering surface, where "name + UHID on every row" IS the rule.
   *
   * WHAT DEFECT WOULD THIS CATCH?
   * D-1 returning where it actually hurt. The round is the screen a nurse reads with a drug in her
   * hand, so a row that names a patient but loses the UHID leaves her with one identifier where
   * the five rights require two — and two patients with the same name on one ward is not a rare
   * hospital, it is a Tuesday.
   *
   * This is deliberately EVERY row, and deliberately the round rather than the ward: `uhid` is
   * resolved server-side per row, so a regression in that resolution shows up on the oldest
   * admissions first — exactly the ones a spot check skips.
   */
  test("gives every dose row a name AND a UHID, on the screen a drug is given from", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.nurse);
    const sites = await branchNames(page);
    expect(sites.length, "the switcher offered no site to work in").toBeGreaterThan(0);
    await switchToBranch(page, sites[0] as string);
    await page.goto("/medication-round");

    await expect(page.getByRole("heading", { name: /medication round/i })).toBeVisible();

    /**
     * The patient cards, and only those. Each card holds a nested list of its dose slots, so a
     * bare `getByRole("listitem")` would also return every slot — none of which carries a UHID,
     * and all of which would fail this check for the wrong reason. `:scope > li` is the direct
     * children of the round's own list.
     */
    const patientRows = page.getByRole("main").getByRole("list").first().locator(":scope > li");

    await expect(async () => {
      // One round trip: the first paragraph of each card is its identity line.
      const lines = await patientRows.evaluateAll((rows) =>
        rows.map((row) => (row.querySelector("p")?.textContent ?? "").trim()),
      );
      expect(lines.length, "the round rendered no patients — nothing to prove").toBeGreaterThan(0);

      for (const line of lines) {
        expect(line, "a dose row carried no UHID beside the patient's name").toMatch(/UH-?\d+/i);
        const name = line.replace(/UH-?\d+/i, "").trim();
        expect(name, `a dose row read "${line}" where a patient's name belongs`).not.toMatch(
          /^(—|-|)$/,
        );
      }
    }).toPass({ timeout: 25_000 });
  });
});
