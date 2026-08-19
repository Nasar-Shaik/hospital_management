import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  branchButton,
  branchNames,
  escapeRe,
  signIn,
  switchToBranch,
} from "./support/app";
import { apiOrigin, sites, token } from "./support/api";

/**
 * WEB-20 / BR-08 — the header and the data must never disagree.
 *
 * WHAT DEFECT WOULD THIS CATCH?
 * The original web defect this whole design exists to prevent: the switcher says one site while
 * the rows on screen still belong to another. A nurse reading a ward list under the wrong site's
 * name is looking at patients who are not in front of her — and every clinical decision she takes
 * from that screen is about the wrong people.
 *
 * ── WHY THIS CANNOT BE PROVEN ANYWHERE ELSE ─────────────────────────────────
 * The API already refuses cross-branch reads, and `branchIsolation.int.test.ts` pins that in 109
 * tests. None of them can fail this way, because the defect is not in the answer — it is in the
 * browser continuing to SHOW the previous answer after the question changed. It needs a real
 * React tree, a real cache and a real re-render, which jsdom-with-mocked-fetch cannot stage.
 *
 * ── WHY THE SITE NAMES ARE DISCOVERED, NOT WRITTEN DOWN ─────────────────────
 * `seed:validation` names the second site "Riverside Annexe" on a clean hospital and ADOPTS
 * whatever branch already exists when the hospital is at its cap. Both are legitimate seeds, so a
 * hardcoded name would be a suite that passes on one database and fails on another.
 */
test.describe("switching sites", () => {
  test("repaints the ward, and leaves nothing of the previous site behind", async ({ page }) => {
    await signIn(page, ACCOUNTS.nurse);

    /**
     * A hard assertion, not a skip. `preflight.setup.ts` has already proved the hospital has two
     * open sites with disjoint occupied beds, so reaching here with fewer means the switcher is
     * not offering what the account can reach — which is a defect in the product, not a reason to
     * report this test as passed.
     */
    const sites = await branchNames(page);
    expect(
      sites.length,
      "the switcher offered fewer sites than the account can work in",
    ).toBeGreaterThanOrEqual(2);
    const [siteA, siteB] = sites as [string, string];

    // ── Site A ────────────────────────────────────────────────────────────
    await switchToBranch(page, siteA);
    await page.goto("/ward");

    // Wait for real occupied beds rather than a spinner, then remember what this site showed.
    const bedsAtA = await bedCodes(page);
    expect(bedsAtA.length, `${siteA} showed no occupied beds to compare against`).toBeGreaterThan(
      0,
    );

    // ── Switch, without leaving the page ──────────────────────────────────
    await switchToBranch(page, siteB);

    /**
     * THE ASSERTION THAT EARNS THIS FILE. The two sites are different wards with different bed
     * codes, so not one of site A's beds may still be on screen under site B's name. A single
     * survivor is cross-branch display of PHI.
     *
     * `toPass` retries the whole check while the routed subtree is discarded and refetched — the
     * wait is on the DATA having changed, never on a timer.
     */
    await expect(async () => {
      const bedsAtB = await bedCodes(page);
      const stale = bedsAtB.filter((b) => bedsAtA.includes(b));
      expect(stale, `beds from ${siteA} survived a switch to ${siteB}`).toEqual([]);
    }).toPass({ timeout: 20_000 });

    // And the header still agrees with what is on screen.
    await expect(branchButton(page)).toHaveText(new RegExp(escapeRe(siteB)));

    // ── And back again, because a cache can be wrong in one direction only ─
    await switchToBranch(page, siteA);
    await expect(async () => {
      expect(await bedCodes(page)).toEqual(expect.arrayContaining(bedsAtA));
    }).toPass({ timeout: 20_000 });
  });

  test("keeps the choice across a full page load", async ({ page }) => {
    await signIn(page, ACCOUNTS.nurse);
    const sites = await branchNames(page);
    expect(
      sites.length,
      "the switcher offered fewer sites than the account can work in",
    ).toBeGreaterThanOrEqual(2);
    const siteB = sites[1] as string;

    await switchToBranch(page, siteB);

    /**
     * A reload is a new React tree with no memory but the stored selection. If the choice does not
     * survive it, a refresh silently moves a clinician to another site mid-shift — and the screen
     * that comes back looks entirely normal.
     */
    await page.reload();
    await expect(branchButton(page)).toHaveText(new RegExp(escapeRe(siteB)));
  });

  /**
   * ── D19: A WRITE THAT NEEDS A SITE IS NOT OFFERED UNTIL THERE IS ONE ──────
   *
   * WHAT DEFECT WOULD THIS CATCH?
   * The one that was met twice in one session and worked around in a fixture rather than fixed.
   * With the header on "All branches", the theatre board offered "Book a procedure", the emergency
   * board offered "Triage", and both refused on submit with `HMS-BRANCH-001` — after the user had
   * chosen a patient, a theatre and a time, or picked a priority and typed a chief complaint.
   * Switching site to fix it closed the modal and discarded the lot.
   *
   * ── WHY THIS CANNOT BE PROVEN IN JSDOM ───────────────────────────────────
   * `emergencyBoard.test.tsx` proves the guard given a branch context. It cannot prove that the
   * REAL application arrives at that context: the aggregate state comes from `/me/branches` plus
   * `reconcileBranch` plus an empty `sessionStorage`, and a signed-in administrator landing in
   * "All branches" is the starting condition the whole defect depends on. That is a property of
   * the running app, not of a component.
   *
   * ── AND WHY THE SERVER IS ASSERTED IN THE SAME TEST ──────────────────────
   * Because the two claims are only worth anything together: the button is disabled BECAUSE the
   * write cannot succeed, and it must remain true that it cannot succeed. A version of this fix
   * that disabled the button and relaxed the server would pass a UI-only test and would be
   * strictly worse than the defect.
   */
  test("does not offer a branch-stamped write until a site is chosen", async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page, ACCOUNTS.admin);

    // A fresh context remembers no site, and an administrator may aggregate — so this is where a
    // real working day starts, not a state the test had to construct.
    await expect(branchButton(page)).toHaveText(/All branches/);

    await page.goto("/theatres");
    await expect(page.getByRole("heading", { name: "Operation theatres" })).toBeVisible();

    const book = page.getByRole("button", { name: "Book a procedure" });
    await expect(book).toBeVisible();
    await expect(book).toBeDisabled();
    await expect(page.getByText(/Choose a site before you/)).toBeVisible();

    // ── The server's half, on the same page load ─────────────────────────────
    const api = apiOrigin(baseURL ?? "http://sunrise.localhost:3000");
    const adminToken = await token(request, api, ACCOUNTS.admin);
    const refused = await request.post(`${api}/api/v1/theatres`, {
      headers: { authorization: `Bearer ${adminToken}` }, // deliberately no X-Active-Branch
      data: { name: "Should Not Exist", code: "OTX9", kind: "major_ot" },
    });
    expect(refused.status()).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "HMS-BRANCH-001",
    );

    // ── And the choice, made where the refusal was ───────────────────────────
    const open = await sites(request, api, adminToken);
    const site = open[0]!;
    await page.getByRole("button", { name: site.name, exact: true }).click();

    await expect(branchButton(page)).toHaveText(new RegExp(escapeRe(site.name)));
    await expect(page.getByText(/Choose a site before you/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Book a procedure" })).toBeEnabled();
  });

  /** The same guard, on the other board it was met on. */
  test("guards the emergency board's writes the same way", async ({ page }) => {
    await signIn(page, ACCOUNTS.nurse);
    await expect(branchButton(page)).toHaveText(/All branches/);

    await page.goto("/emergency");
    await expect(page.getByRole("heading", { name: "Emergency" })).toBeVisible();
    await expect(page.getByText(/Choose a site before you/)).toBeVisible();

    /**
     * Every triage control on the board, not one of them: `.first()` would pass while the rest of
     * the department was still offering a form nobody can submit. The board legitimately holds
     * rows from other runs, which is exactly why the assertion is over all of them.
     */
    const triage = page.getByRole("button", { name: /^(Triage|Re-assess)$/ });
    const count = await triage.count();
    for (let i = 0; i < count; i += 1) await expect(triage.nth(i)).toBeDisabled();
  });
});

/**
 * The occupied bed codes currently on screen (`GW-1`, `AW-3`).
 *
 * Read out of the rendered text rather than off a DOM structure: the ward is a list of buttons
 * today and could be a table tomorrow, and this test is about WHICH BEDS are shown, not how they
 * are marked up. Waits for at least one, so it never compares against an empty loading frame.
 */
async function bedCodes(page: import("@playwright/test").Page): Promise<string[]> {
  let found: string[] = [];
  await expect(async () => {
    const text = await page.getByRole("main").innerText();
    found = [...new Set([...text.matchAll(/\b[A-Z]{2}-\d+\b/g)].map((m) => m[0]))].sort();
    expect(found.length, "no occupied beds rendered yet").toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  return found;
}
