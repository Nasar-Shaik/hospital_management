import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, sites, token } from "./support/api";

/**
 * The general store, through a browser.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * `inventory.int.test.ts` proves the rules — the shelf that cannot go negative, the ledger that
 * reconciles, the per-site balance, every boundary. None of that can fail the way this can.
 *
 * What a browser is the only witness to: a store keeper who holds all four `inventory:*`
 * permissions and still finds no Receive button, because the page asked for one the role does not
 * hold (a REAL defect class here — `nursing:manage` hid behind it for two milestones, `ot:schedule`
 * for six); the `HMS-INV-002` refusal arriving as a silent no-op instead of a sentence the keeper
 * can act on; and the shelf number on the list disagreeing with the ledger behind it.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Three things could make this pass on stale data, and all three are closed:
 *
 *   THE ITEM IS NAMED, never picked. `GLOVE-M` comes from the starter list every hospital is
 *   seeded with (`seed/storeItems.ts`), so the row is the same row on every machine. No `.first()`
 *   over a table that grows.
 *
 *   THE ASSERTIONS ARE RELATIVE. The opening balance is READ, not assumed, and every expectation
 *   is opening ± what this run moved. A hospital somebody has been clicking around in does not
 *   change the answer.
 *
 *   THE RUN RETURNS THE SHELF TO WHERE IT FOUND IT. Receive N, issue the same N. The ledger keeps
 *   both rows — a ledger is supposed to accumulate, and nothing here asserts on its length — but
 *   the BALANCE is exactly as it was, so ten runs in a row leave the tenth looking like the first.
 *   (`pharmacyDispensing.spec.ts` learned this the hard way: it leaked a queued patient per run
 *   until 57 of them pushed the doctor's queue past a page boundary.)
 */

interface StoreItem {
  id: string;
  code: string;
  name: string;
  onHand: number;
  unit: string;
}

/**
 * Where an issue may go. Read from the STORE'S own route, not `/departments` — the store keeper
 * deliberately holds no `patient:read`, and this spec running as that account is what proves the
 * picker can actually be filled in by the person who has to fill it in.
 */
interface Destination {
  id: string;
  name: string;
}

/** The starter item every seeded hospital has. Named, so the row is the same row everywhere. */
const ITEM_CODE = "GLOVE-M";
const ITEM_NAME = "Examination gloves, medium";

/** Big enough to read at a glance in a failure, small enough to be obviously a test. */
const MOVED = 25;

async function storeApi(request: APIRequestContext, baseURL: string | undefined) {
  const api = apiOrigin(baseURL ?? "http://sunrise.localhost:3000");
  const bearer = await token(request, api, ACCOUNTS.storekeeper);
  const [site] = await sites(request, api, bearer);
  expect(site, "the store keeper can reach no active site").toBeTruthy();
  return { api, bearer, site: site! };
}

/** The shelf as the SERVER sees it at one site — the number the screen must agree with. */
async function onHand(
  request: APIRequestContext,
  api: string,
  bearer: string,
  branchId: string,
): Promise<number> {
  const rows = await apiGet<StoreItem[]>(
    request,
    `${api}/api/v1/inventory-items`,
    bearer,
    branchId,
  );
  const row = rows.find((r) => r.code === ITEM_CODE);
  expect(
    row,
    `${ITEM_CODE} is not in the store list — run \`pnpm seed:migrate --all\``,
  ).toBeTruthy();
  return row!.onHand;
}

/** The row for our named item. Anchored on the name, never on position. */
function itemRow(page: Page) {
  return page.getByRole("row").filter({ hasText: ITEM_NAME });
}

async function openStore(page: Page, siteName: string) {
  await signIn(page, ACCOUNTS.storekeeper);
  // Sunrise has two sites, so a branch-stamping write is refused until one is chosen (D19).
  await switchToBranch(page, siteName);
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "General store" })).toBeVisible();
  await expect(itemRow(page)).toHaveCount(1);
}

test.describe("the general store", () => {
  test("a delivery is booked in, issued to a ward, and the ledger explains both", async ({
    page,
    request,
    baseURL,
  }) => {
    const { api, bearer, site } = await storeApi(request, baseURL);
    const opening = await onHand(request, api, bearer, site.id);

    const destinations = await apiGet<Destination[]>(
      request,
      `${api}/api/v1/inventory-destinations`,
      bearer,
    );
    const ward = destinations[0];
    expect(ward, "the hospital has no department to issue to").toBeTruthy();

    await openStore(page, site.name);

    /**
     * The screen must agree with the API about the number, at the same site. This is the
     * assertion that would have caught a per-site balance rendered from a hospital-wide read.
     */
    await expect(itemRow(page)).toContainText(`${String(opening)} box`);

    /* ── receive ── */
    await itemRow(page).getByRole("button", { name: "Receive" }).click();
    const receiveDialog = page.getByRole("dialog");
    await expect(receiveDialog).toContainText("Receive");
    await receiveDialog.getByLabel("Quantity (box)").fill(String(MOVED));
    await receiveDialog.getByRole("button", { name: "Book it in" }).click();

    await expect(receiveDialog).toBeHidden();
    await expect(itemRow(page)).toContainText(`${String(opening + MOVED)} box`);

    /* ── issue the same quantity back out ── */
    await itemRow(page).getByRole("button", { name: "Issue" }).click();
    const issueDialog = page.getByRole("dialog");
    await issueDialog.getByLabel("Quantity (box)").fill(String(MOVED));
    await issueDialog.getByLabel("To department").selectOption(ward!.id);
    await issueDialog.getByRole("button", { name: "Issue" }).click();

    await expect(issueDialog).toBeHidden();
    await expect(itemRow(page)).toContainText(`${String(opening)} box`);

    /* ── and the ledger says how it got there ── */
    await itemRow(page).getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog");
    await expect(history).toContainText(`+${String(MOVED)}`);
    await expect(history).toContainText(`-${String(MOVED)}`);
    // The destination is on the row, so the slip answers "who took it" without a second lookup.
    await expect(history).toContainText(ward!.name);

    // The shelf is exactly where this run found it.
    expect(await onHand(request, api, bearer, site.id)).toBe(opening);
  });

  /**
   * The negative that matters. The shelf refusing to go below zero is the one rule this module has
   * that the pharmacy deliberately does not, and a browser is where we find out whether the
   * refusal reaches a person or dies in a console.
   */
  test("issuing more than the shelf holds is refused, in words, and moves nothing", async ({
    page,
    request,
    baseURL,
  }) => {
    const { api, bearer, site } = await storeApi(request, baseURL);
    const opening = await onHand(request, api, bearer, site.id);

    const destinations = await apiGet<Destination[]>(
      request,
      `${api}/api/v1/inventory-destinations`,
      bearer,
    );
    const ward = destinations[0];
    expect(ward).toBeTruthy();

    await openStore(page, site.name);

    await itemRow(page).getByRole("button", { name: "Issue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Quantity (box)").fill(String(opening + 1000));
    await dialog.getByLabel("To department").selectOption(ward!.id);
    await dialog.getByRole("button", { name: "Issue" }).click();

    // The server's sentence, on screen, in the dialog the keeper is still standing in.
    await expect(dialog).toContainText(/Not enough stock/i);
    await expect(dialog).toBeVisible();

    // And nothing moved — on the screen behind it, and in the database.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(itemRow(page)).toContainText(`${String(opening)} box`);
    expect(await onHand(request, api, bearer, site.id)).toBe(opening);
  });
});
