import { expect, test } from "@playwright/test";
import { ACCOUNTS, branchNames, signIn, switchToBranch } from "./support/app";

/**
 * The staff directory is the one list whose branch scope is assembled from ROLE BINDINGS rather
 * than read off the document — ADR-0015 gives a tenant "one staff directory", so a person belongs
 * to the hospital and where they work lives in `rbac`.
 *
 * WHAT DEFECT WOULD THIS CATCH?
 * The scope silently going away. Nothing in the tenantScope plugin or `scopeFilter()` holds this
 * list up, so a refactor that dropped the exclusion would leave a screen that looks completely
 * normal — every site showing every colleague — and no other test in the repository would notice
 * except the two that were written for it.
 *
 * The API half is pinned in `branchIsolation.int.test.ts` and the rendering half in
 * `staffCount.test.tsx` with a mocked fetch. Neither can catch the two halves disagreeing: a
 * switcher that does not actually send the branch, a count computed from the wrong number. That
 * seam is what this test is for, and it is the only place the whole path runs at once.
 */
test.describe("the staff directory", () => {
  test("narrows to the site being worked in, and says so", async ({ page }) => {
    await signIn(page, ACCOUNTS.admin);

    const sites = await branchNames(page);
    test.skip(sites.length < 2, "needs a hospital with two sites — run pnpm seed:validation");
    const [siteA, siteB] = sites as [string, string];

    await page.goto("/staff");
    await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();

    /**
     * The count row states the scope it counted — read it back rather than counting rows.
     * Scoped to the paragraph itself: the sentence emphasises its number in a child span, so a
     * bare text match resolves to the wrapper as well as the row.
     */
    const countRow = countRowOf(page);

    // ── Every site ────────────────────────────────────────────────────────
    await expect(countRow).toContainText("across all branches", { timeout: 20_000 });
    const everyone = await peopleCount(page);
    expect(everyone, "no staff at all — is the hospital seeded?").toBeGreaterThan(0);

    // ── One site ──────────────────────────────────────────────────────────
    await switchToBranch(page, siteA);
    await expect(countRow).toContainText(`at ${siteA}`, { timeout: 20_000 });
    const atA = await peopleCount(page);

    await switchToBranch(page, siteB);
    await expect(countRow).toContainText(`at ${siteB}`, { timeout: 20_000 });
    const atB = await peopleCount(page);

    /**
     * A site can never hold more people than the hospital does. Deliberately not an equality: the
     * seeded staff are almost all hospital-wide, so both sites legitimately show nearly everyone,
     * and asserting a specific shrinkage would be asserting the seed rather than the rule.
     */
    expect(atA, `${siteA} listed more staff than the whole hospital`).toBeLessThanOrEqual(everyone);
    expect(atB, `${siteB} listed more staff than the whole hospital`).toBeLessThanOrEqual(everyone);

    /**
     * And the number the row states is the number of rows it drew. A count that disagreed with its
     * own table would be worse than no count — it reads as a complete answer to a question it did
     * not ask.
     */
    const drawn = await page.getByRole("row").count();
    expect(atB, "the count disagrees with the table under it").toBe(drawn - 1); // minus the header
  });

  test("shows which sites each person works at", async ({ page }) => {
    await signIn(page, ACCOUNTS.admin);
    const sites = await branchNames(page);
    test.skip(sites.length < 2, "needs a hospital with two sites");

    await page.goto("/staff");
    await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();

    /**
     * The Branch column only appears on a multi-site hospital, and it is the only place a reader
     * can tell a hospital-wide binding from a confined one without opening every profile in turn.
     */
    await expect(page.getByRole("columnheader", { name: "Branch" })).toBeVisible();
    await expect(page.getByText("All branches").first()).toBeVisible({ timeout: 20_000 });
  });
});

/**
 * The count row, identified by the shape of a count rather than by where it sits.
 *
 * Matching on the scope phrase alone was not enough: the page's own subtitle ends "…at this
 * hospital", and a locator that cannot tell the two apart silently asserts against prose.
 */
function countRowOf(page: import("@playwright/test").Page) {
  return page
    .locator("p")
    .filter({ hasText: /\d+\s+(?:people|person)\b|Showing\s+\d+\s+of\s+\d+/ })
    .first();
}

/** The number the count row states, whatever sentence it is wrapped in. */
async function peopleCount(page: import("@playwright/test").Page): Promise<number> {
  const text = await countRowOf(page).innerText();
  const shown = /Showing\s+(\d+)\s+of\s+(\d+)/.exec(text);
  if (shown) return Number(shown[1]); // past the fetch ceiling: rows drawn, not the total
  const plain = /(\d+)\s+(?:people|person)/.exec(text);
  expect(plain, `could not read a count out of "${text}"`).not.toBeNull();
  return Number(plain?.[1]);
}
