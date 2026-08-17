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
     * ── A DIFFERENCE FROM THE RUNBOOK, RECORDED RATHER THAN ASSERTED AWAY ───
     * WEB-02 reads as though browsing the bad address is enough to be told. It is not: the
     * message is mapped from the login RESPONSE (`login/page.tsx`, the `HMS-TEN-001` case), so it
     * appears on submit. The invariant the row exists to protect — the address is blamed, not the
     * credentials — holds either way, so this asserts that and does not invent an on-load
     * requirement the implementation never claimed. The timing difference is written up in
     * TESTING.md rather than fixed here.
     */
    await page.goto("http://nosuchhospital.localhost:3000/login");

    // The shell resolved no hospital, so it names none — the first, silent signal.
    await expect(page.getByText("Sunrise Multispeciality")).toHaveCount(0);

    await page.getByRole("textbox", { name: "Email" }).fill(ACCOUNTS.nurse);
    await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The address, explicitly. NOT "incorrect email or password", which would send a whole
    // hospital's staff to reset credentials that were never the problem.
    await expect(page.getByText(/does not belong to any hospital/i)).toBeVisible();
    await expect(page.getByText(/Incorrect email or password/i)).toHaveCount(0);
    await expect(page).toHaveURL(/\/login/);
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
