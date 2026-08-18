import { expect, test } from "@playwright/test";
import { ACCOUNTS, PASSWORD, signIn } from "./support/app";

/**
 * WEB-01, WEB-02 — getting in, and being told the truth when you cannot.
 *
 * WHAT DEFECT WOULD THIS CATCH?
 *  · A login that succeeds at the API and then lands on a blank shell — the permission→navigation
 *    mapping breaking, which the runbook calls out as the tell that the tab bar was derived wrong.
 *  · A wrong HOSTNAME being reported as a wrong password. The hostname is the tenant (ADR-0005),
 *    so a hospital whose DNS is misconfigured would have its staff typing their passwords again
 *    and again at a URL that could never have worked.
 *  · A failed sign-in clearing the email field, which teaches users the app lost their input.
 *
 * None of this is provable in jsdom with a mocked fetch: it needs the real Next middleware, the
 * real tenant resolution and a real navigation.
 */
test.describe("signing in", () => {
  test("lands in the hospital, named, with somewhere to go", async ({ page }) => {
    await signIn(page, ACCOUNTS.nurse);

    // The hostname chose the hospital, and the shell says which one it resolved to.
    await expect(page.getByText("Sunrise Multispeciality").first()).toBeVisible();

    // A signed-in nurse has navigation. An empty sidebar is the permission-mapping failure.
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link").first()).toBeVisible();

    // And the header knows who she is, which is what every clinical record will be attributed to.
    await expect(page.locator("header").getByText("NURSE")).toBeVisible();
  });

  test("blames the address, not the password, when the hospital does not exist", async ({
    page,
  }) => {
    /**
     * A slug no tenant owns. The API answers `HMS-TEN-001` and the browser must translate that
     * into the one sentence that sends somebody to fix a web address rather than to reset a
     * password — WEB-02's actual point.
     *
     * ── WEB-02, DECIDED: ON LOAD, NOT ON SUBMIT ─────────────────────────────
     * The runbook's step is "browse a slug that does not exist", and it was right to expect an
     * answer there. `BrandingProvider` already calls the public `GET /site` on every page load, so
     * the app HAD a definitive `HMS-TEN-001` before the form was even usable — and threw it away.
     * The only way to be told was to type a real password at a host that is not your hospital's.
     * Publishing that one flag was the fix; both halves are asserted below.
     */
    await page.goto("http://nosuchhospital.localhost:3000/login");

    // The shell resolved no hospital, so it names none — the first, silent signal.
    await expect(page.getByText("Sunrise Multispeciality")).toHaveCount(0);

    /**
     * THE ASSERTION THAT MOVED. Before anything is typed, before anything is submitted: the
     * address is named as the problem. Nothing has been sent but the public branding call.
     */
    await expect(page.getByText(/does not belong to any hospital/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("textbox", { name: "Password" })).toHaveValue("");

    // And it survives a submit rather than being replaced by a credential message — which would
    // send a whole hospital's staff to reset passwords that were never the problem.
    await page.getByRole("textbox", { name: "Email" }).fill(ACCOUNTS.nurse);
    await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText(/does not belong to any hospital/i)).toBeVisible();
    await expect(page.getByText(/Incorrect email or password/i)).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/);
  });

  /**
   * The other half of WEB-02, and the reason the flag is `HMS-TEN-001` and nothing else.
   *
   * WHAT DEFECT WOULD THIS CATCH?
   * A real hospital being told it does not exist. If the load-time check were widened to "the
   * branding call failed" — a network blip, a restarting API, a suspended tenant — then every
   * clinician at a working hospital would meet "this address does not belong to any hospital"
   * during a thirty-second outage, and the support call that follows is a hospital believing its
   * URL changed. This pins the message to the one host that genuinely resolves to nothing.
   */
  test("does not accuse a real hospital's address of being wrong", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    // Branding has resolved (the hospital is named), and no address complaint came with it.
    await expect(page.getByText("Sunrise Multispeciality").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/does not belong to any hospital/i)).toHaveCount(0);
  });

  test("keeps what you typed when the password is wrong", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(ACCOUNTS.nurse);
    await page.getByRole("textbox", { name: "Password" }).fill(`${PASSWORD}-wrong`);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Refused, and still on the sign-in page rather than a half-authenticated shell.
    await expect(page).toHaveURL(/\/login/);
    // The email survives. Clearing it is how an app teaches people to distrust it.
    await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(ACCOUNTS.nurse);
  });
});
