import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * Emergency v1, through a browser.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * `emergency.int.test.ts` proves the rules — the ranking, the disposition, every boundary. None of
 * it can fail the way this can.
 *
 * What a browser is the only witness to: an emergency arrival that registers perfectly and never
 * appears on the board, because the desk's checkbox sends `class: OP`; a triage control the nurse
 * cannot see because the page asked for a permission she does not hold; and — the one this
 * milestone exists for — a patient who is discharged and STAYS on the board, so the department
 * spends the evening looking at people who went home hours ago.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every run registers its OWN patient with a name carrying the run's stamp, and every locator is
 * anchored on that name. Nothing here reads "the first row": the board accumulates a row per run
 * until each is dispositioned, and `.first()` would eventually assert against somebody else's
 * patient. The walk ends by transferring the patient out, so the board is left exactly as it was
 * found — a run that dies halfway leaves one row, which the board is designed to show.
 */

interface Doctor {
  id: string;
  name: string;
}

interface Fixture {
  siteName: string;
  siteId: string;
  patientId: string;
  patientName: string;
  doctorName: string;
}

let fixture: Fixture;

/**
 * A patient who exists but has never been to the hospital.
 *
 * Registration itself is proved by `pageHealth` and by the patients suite; re-driving that form
 * here would be a slower second copy of a test that exists, and the subject is the EMERGENCY
 * DEPARTMENT. What is deliberately still driven in the browser is the ARRIVAL — the desk's
 * "Emergency arrival" checkbox is the thing that decides whether this patient ever reaches the
 * board, and it is exactly the kind of wiring a jsdom test cannot see.
 */
async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const adminToken = await token(request, api, ACCOUNTS.admin);
  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const site = open[0]!;

  const stamp = String(Date.now()).slice(-6);
  const patientName = `ED Walkin ${stamp}`;
  const created = await apiPost<{ patient: { id: string } }>(
    request,
    `${api}/api/v1/patients`,
    adminToken,
    { name: patientName, gender: "male", contact: { phone: `9${String(Date.now()).slice(-9)}` } },
    site.id,
  );

  const doctors = await apiGet<Doctor[]>(request, `${api}/api/v1/doctors`, adminToken, site.id);
  const doctor = doctors.find((d) => /Rao/.test(d.name));
  expect(doctor, "the doctor this suite signs in as is not in the doctor list").toBeTruthy();

  return {
    siteName: site.name,
    siteId: site.id,
    patientId: created.patient.id,
    patientName,
    doctorName: doctor!.name,
  };
}

/** The board row for THIS run's patient. Never `.first()` — see the header. */
function boardRow(page: Page, name: string) {
  return page.getByRole("row").filter({ hasText: name });
}

test.beforeAll(async ({ request, baseURL }) => {
  fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
});

test.describe.serial("the emergency department, from the door to the disposition", () => {
  test("the desk registers an emergency arrival and it reaches the board untriaged", async ({
    page,
  }) => {
    const f = fixture;
    await signIn(page, ACCOUNTS.receptionist);
    // A registration is a WRITE, so it needs one site selected — the same rule every branch-stamped
    // write follows (ADR-0015).
    await switchToBranch(page, f.siteName);

    await page.goto("/reception");
    await expect(page.getByRole("button", { name: "Register arrival" })).toBeVisible({
      timeout: 20_000,
    });

    // Selected by ID, not by label: the option reads "Name · UHID" and the UHID is assigned by the
    // server, so a label match would need a second round trip to learn what it says.
    await page.getByLabel("Patient").selectOption(f.patientId);
    await page.getByLabel("Doctor / department").selectOption({ label: f.doctorName });

    // THE CHECKBOX UNDER TEST. Without it the visit is `class: OP` and never reaches the board —
    // which is the defect this whole test exists to make impossible to ship.
    const emergency = page.getByRole("checkbox", { name: /Emergency arrival/i });
    await expect(emergency).toBeVisible();
    await emergency.check();

    await page.getByRole("button", { name: "Register arrival" }).click();
    await expect(page.getByText(/registered/i).first()).toBeVisible({ timeout: 20_000 });
  });

  test("the nurse sees them at the TOP as untriaged, and assesses them", async ({ page }) => {
    const f = fixture;
    await signIn(page, ACCOUNTS.nurse);
    await switchToBranch(page, f.siteName);
    await page.goto("/emergency");
    await expect(page.getByRole("heading", { name: "Emergency" })).toBeVisible();

    const row = boardRow(page, f.patientName);
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    // The claim that matters: nobody has assessed them, and the board says so loudly rather than
    // leaving the cell blank.
    await expect(row).toContainText("Not triaged");

    await row.getByRole("button", { name: "Triage", exact: true }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("Triage this patient")).toBeVisible();
    await modal.getByRole("button", { name: "Critical" }).click();
    await modal.getByLabel("Chief complaint").fill("Chest pain since this morning");
    await modal.getByRole("button", { name: "Save triage" }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });

    await expect(row).toContainText("Critical", { timeout: 20_000 });
    await expect(row).toContainText("Chest pain since this morning");

    /**
     * ── AND HANDS THEM TO A DOCTOR ──────────────────────────────────────────
     * A separate act from the assessment, on purpose — triage says how sick they are, this says
     * they are now somebody's patient. Without this button the board is a dead end: a `critical`
     * patient sits at "Arrived" because the only screen that could queue them is the reception
     * register, which is not where the nurse is standing.
     */
    await row.getByRole("button", { name: "Send to doctor" }).click();
    await expect(row).toContainText("Waiting", { timeout: 20_000 });
  });

  test("the doctor works them up through the ordinary clinical screens", async ({ page }) => {
    const f = fixture;
    await signIn(page, ACCOUNTS.doctor);
    await switchToBranch(page, f.siteName);

    /**
     * ── THE POINT OF THE WHOLE MODULE, ASSERTED IN A BROWSER ────────────────
     * The ED patient turns up in the doctor's ORDINARY worklist, not in an emergency copy of it.
     * If somebody ever builds a second clinical workspace for the ED, this is the test that will
     * still be looking for the patient in the first one.
     */
    await page.goto("/my-patients");
    const inList = page.getByRole("button", { name: new RegExp(f.patientName) });
    await expect(inList.first()).toBeVisible({ timeout: 20_000 });
    await inList.first().click();

    await page.getByRole("button", { name: /^Call in/ }).click();
    // The consultation pads are what "call in" unlocks — the same ones every other patient gets.
    await expect(page.getByRole("button", { name: "Order" })).toBeVisible({ timeout: 20_000 });
  });

  test("a disposition takes them off the board", async ({ page }) => {
    const f = fixture;
    await signIn(page, ACCOUNTS.doctor);
    await switchToBranch(page, f.siteName);
    await page.goto("/emergency");

    const row = boardRow(page, f.patientName);
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    // Being with a doctor does NOT take them off it — they are still in the department.
    await expect(row).toContainText("With doctor");

    await row.getByRole("button", { name: "Transfer out" }).click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("Sent to").fill("City General — cardiology");
    await modal.getByLabel("Why").fill("Needs a cath lab.");
    await modal.getByRole("button", { name: "Record transfer" }).click();
    await expect(modal).toHaveCount(0, { timeout: 20_000 });

    // Gone — and gone after a full reload, so this is the server's answer and not an optimistic one.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Emergency" })).toBeVisible();
    await expect(boardRow(page, f.patientName)).toHaveCount(0, { timeout: 20_000 });
  });
});
