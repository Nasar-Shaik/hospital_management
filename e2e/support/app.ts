import { expect, type Page } from "@playwright/test";

/**
 * The handful of things every browser test needs, and nothing else.
 *
 * Kept deliberately thin: a page object per screen would be a second description of the UI that
 * has to be maintained alongside the UI itself, and this suite is small enough that the tests read
 * better naming what they click.
 */

/** Every demo account shares this. Dev-only — `seedDemo` refuses to run against production. */
export const PASSWORD = "123456";

export const ACCOUNTS = {
  nurse: "nurse@sunrise.test",
  doctor: "drrao@sunrise.test",
  admin: "admin@sunrise.test",
  receptionist: "reception@sunrise.test",
} as const;

/**
 * Sign in and wait for the application, not for a timer.
 *
 * The assertion on the URL is the synchronisation point: the sign-in POST, the token exchange and
 * the first authenticated render all have to finish before `/dashboard` is the address, so waiting
 * on it removes every reason to sleep.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * The branch switcher's own button, whose accessible name is the site currently being worked in.
 *
 * That double duty is the reason the branch tests can assert on it directly: the control that
 * changes the scope is also the label that reports it, so "the header and the data agree" is a
 * question this element can answer.
 */
export function branchButton(page: Page) {
  // `title="Switch branch"` is the switcher's own, stable handle — the accessible NAME is the site
  // currently selected and therefore changes with every test, which is what this locator must not.
  return page.getByTitle("Switch branch");
}

/** The open menu. Scoped so an option never collides with the trigger that has the same name. */
function branchMenu(page: Page) {
  return page.getByText("Working in", { exact: true }).locator("..");
}

/**
 * The sites this account may work in, read from the switcher rather than from a fixture.
 *
 * `seed:validation` names the second site differently depending on whether it created one or
 * ADOPTED an existing branch when the hospital was already at its cap — it is "Riverside Annexe"
 * on a clean seed and whatever was already there otherwise. Hardcoding either name would produce
 * a suite that passes on one machine's database and fails on another's, so the names are
 * discovered here and the tests speak in terms of "the other site".
 */
export async function branchNames(page: Page): Promise<string[]> {
  await branchButton(page).click();
  const menu = branchMenu(page);
  await expect(menu.getByRole("button").first()).toBeVisible();

  const names = await menu.getByRole("button").allInnerTexts();
  // Close it again by clicking the trigger — Escape is not wired to this menu.
  await branchButton(page).click();
  await expect(menu).toHaveCount(0);

  // The rendered button stacks the name over its code ("Main Branch\nMAIN"); the first line is the
  // name. "All branches" is the aggregate option, not a site.
  return names
    .map((t) => (t.split("\n")[0] ?? "").trim())
    .filter((n) => n.length > 0 && n !== "All branches");
}

/** Switch the active site and wait for the switcher itself to report the change. */
export async function switchToBranch(page: Page, name: string): Promise<void> {
  await branchButton(page).click();
  await branchMenu(page)
    .getByRole("button", { name: new RegExp(escapeRe(name)) })
    .first()
    .click();
  // The trigger reporting the new site is the switch having happened, not a timer.
  await expect(branchButton(page)).toHaveText(new RegExp(escapeRe(name)));
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
