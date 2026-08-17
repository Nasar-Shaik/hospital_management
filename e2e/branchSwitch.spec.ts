import { expect, test } from "@playwright/test";
import {
  ACCOUNTS,
  branchButton,
  branchNames,
  escapeRe,
  signIn,
  switchToBranch,
} from "./support/app";

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

    const sites = await branchNames(page);
    test.skip(sites.length < 2, "needs a hospital with two sites — run pnpm seed:validation");
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
    test.skip(sites.length < 2, "needs a hospital with two sites");
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
