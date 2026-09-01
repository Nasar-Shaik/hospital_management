import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn } from "./support/app";

/**
 * Exporting a register — the one thing on these pages that only a browser does.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The API's job ends when it has written the CSV bytes; `reporting` is covered at the integration
 * layer. What is NOT covered anywhere is the half the browser performs: taking those bytes as a
 * Blob, minting an object URL, naming the file for the period the user chose, clicking a synthetic
 * anchor, and revoking the URL. Every step of that is browser API surface, and a mistake in any of
 * them produces the same symptom — a button that appears to work and delivers no file, or delivers
 * one called `undefined-undefined_to_undefined.csv`.
 *
 * That symptom is invisible from below: `fetchReportCsv` resolves, no error is thrown, no request
 * fails, and the page health sweep is perfectly happy. It is also the kind of failure a user
 * reports as "the export is broken" a month later, because the person who needed the file only
 * needs it at month end.
 *
 * ── WHY ONLY /reports, WHEN /audit ALSO EXPORTS ─────────────────────────────
 * The activity trail exports through the same Blob-and-anchor pattern. A second test of the same
 * mechanism against a different endpoint would cost a minute of every run to re-prove what this
 * one already proves; the parts that DIFFER (which rows, which columns) are the API's, and the
 * API's tests own them. Recorded here so the omission reads as a decision rather than an oversight.
 */
test("the reports page hands over a CSV named for the period it covers", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/reports");

  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  const exportCsv = page.getByRole("button", { name: "Export CSV" });
  await expect(exportCsv).toBeEnabled({ timeout: 30_000 });

  // Arm the listener BEFORE the click — the download can complete faster than the next statement.
  const downloading = page.waitForEvent("download");
  await exportCsv.click();
  const download = await downloading;

  /**
   * The filename is assembled entirely in the browser from the selected report and the selected
   * period. Asserting its SHAPE rather than a literal keeps this true on any day of any month —
   * a hardcoded name would be a test that expires at midnight on the 1st.
   */
  expect(
    download.suggestedFilename(),
    "the exported file was not named for the report and the period",
  ).toMatch(/^[a-z-]+-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);

  /**
   * And it contains a register, not an empty file. A zero-byte download is the exact failure that
   * looks like success — the browser saves it, the button un-spins, and nobody notices until the
   * file is opened.
   */
  const path = await download.path();
  const csv = await readText(path);
  const lines = csv.trim().split("\n");
  expect(lines.length, "the exported CSV had no rows under its header").toBeGreaterThan(1);
  expect(lines[0], "the exported CSV had no header row").toContain(",");
});

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
