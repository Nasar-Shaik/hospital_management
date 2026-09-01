import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * Pharmacy v1 through a browser: the shelf, the prescription, and the gap between them.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The API side is pinned in `prescriptions.int.test.ts` — batches, FEFO, expiry, partial
 * quantities, the over-dispense guard, availability. None of it can fail the way this can.
 *
 * A browser is the only witness to: a prescribing pad that turns availability into a disabled
 * button, so a doctor cannot prescribe what the hospital happens to be out of; a pharmacy counter
 * that shows "10/10 given" when six were handed over, which is the difference between a patient
 * who has their tablets and one who does not; and a shelf view that quietly hides the expired box
 * somebody has to go and pull.
 *
 * ── WHAT IT ARRANGES, AND WHAT IT LEAVES ────────────────────────────────────
 * Two medicines of its own, named per run, and one prescription. The medicines stay — a drug
 * master entry is reference data, exactly like a tariff line, and deleting them is neither
 * possible through the API nor desirable. The prescription is cancelled in teardown so no
 * unfinished handover sits on the pharmacy's queue.
 */

interface Stay {
  id: string;
  patientName: string;
  uhid: string;
}

interface Fixture {
  api: string;
  adminToken: string;
  site: { id: string; name: string };
  /** Stocked, with a batch. The doctor should see units and the pharmacist should dispense part. */
  stocked: { code: string; name: string };
  /** Deliberately never received. The doctor must still be able to prescribe it. */
  outOfStock: { code: string; name: string };
  prescriptionId: string;
  /** The visit this spec opened. Held so the teardown can close it — see `afterAll`. */
  encounterId: string;
  patientName: string;
  uhid: string;
}

let fixture: Fixture;

async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const [adminToken, doctorToken] = await Promise.all([
    token(request, api, ACCOUNTS.admin),
    token(request, api, ACCOUNTS.doctor),
  ]);

  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const site = open[0]!;

  const stamp = Date.now().toString().slice(-8);
  const stocked = { code: `E2E_STOCKED_${stamp}`, name: `E2E Stocked Tablet ${stamp}` };
  const outOfStock = { code: `E2E_OUT_${stamp}`, name: `E2E Out Of Stock Tablet ${stamp}` };

  /**
   * ── TWO REGISTERS, ONE CODE ─────────────────────────────────────────────────
   * The prescribing pad lists the TARIFF (`category: "pharmacy"`); stock lives on the medicine
   * MASTER, keyed on the same code. A drug added to only one of them is either prescribable and
   * untracked, or tracked and unprescribable — the seeded formulary avoids that by being built
   * from the pharmacy tariff, and a hospital adding a new drug has to do both. So does this.
   */
  for (const drug of [stocked, outOfStock]) {
    await apiPost(
      request,
      `${api}/api/v1/tariff`,
      adminToken,
      { ...drug, category: "pharmacy", price: 500 },
      site.id,
    );
  }

  // The master, and a real batch for one of them. The other is left with nothing on purpose.
  for (const drug of [stocked, outOfStock]) {
    await apiPost(
      request,
      `${api}/api/v1/medicines`,
      adminToken,
      { ...drug, form: "tablet" },
      site.id,
    );
  }
  const created = await apiGet<{ id: string; code: string }[]>(
    request,
    `${api}/api/v1/medicines?search=${encodeURIComponent(stamp)}`,
    adminToken,
    site.id,
  );
  const stockedId = created.find((m) => m.code === stocked.code)?.id;
  expect(stockedId, "the medicine this run created was not on the master").toBeTruthy();

  await apiPost(
    request,
    `${api}/api/v1/medicines/${stockedId!}/receive`,
    adminToken,
    {
      quantity: 40,
      batchNo: `B-${stamp}`,
      expiry: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    },
    site.id,
  );

  /**
   * ── ITS OWN PATIENT, IN THE DOCTOR'S OWN QUEUE ──────────────────────────────
   * `/my-patients` lists what is QUEUED for this doctor (`queued: true, doctorId`), not the ward
   * — so borrowing a seeded inpatient put the prescribing pad out of reach entirely. A fresh
   * walk-in is also what the pad is actually for, and it means this run cannot be affected by, or
   * affect, anybody else's patient.
   *
   * The visit is left OPEN: a closed one drops out of the queue, and the prescription has to stay
   * dispensable for the pharmacy half of this spec.
   */
  const patient = await apiPost<{ patient: { id: string; uhid: string } }>(
    request,
    `${api}/api/v1/patients`,
    adminToken,
    { name: `E2E Pharmacy Patient ${stamp}`, gender: "female", contact: { phone: `9${stamp}` } },
    site.id,
  );

  const me = await apiGet<{ id: string }>(request, `${api}/api/v1/auth/me`, doctorToken);
  const encounter = await apiPost<{ encounter: { id: string } }>(
    request,
    `${api}/api/v1/encounters`,
    adminToken,
    { patientId: patient.patient.id, doctorId: me.id, departmentId: me.id },
    site.id,
  );
  /**
   * Into the queue. A newly created encounter is `arrived`, and `queued: true` filters on
   * `in_queue | in_progress | awaiting_results` — so without this the patient exists, is assigned
   * to the doctor, and is invisible on the one screen that prescribes.
   */
  await apiPost(
    request,
    `${api}/api/v1/encounters/${encounter.encounter.id}/queue`,
    adminToken,
    {},
    site.id,
  );

  /**
   * And the consultation is STARTED. The prescribing card opens by default only for a visit that
   * is `in_progress` — which is right: a doctor prescribes during the consultation, not while the
   * patient is still in the waiting room. Leaving it queued left the pad collapsed and the test
   * clicking at a header instead of typing in a search box.
   */
  await apiPost(
    request,
    `${api}/api/v1/encounters/${encounter.encounter.id}/start`,
    doctorToken,
    {},
    site.id,
  );

  const stay = {
    id: encounter.encounter.id,
    patientName: `E2E Pharmacy Patient ${stamp}`,
    uhid: patient.patient.uhid,
  };

  const line = (drug: { code: string; name: string }, quantity: number) => ({
    drugCode: drug.code,
    drugName: drug.name,
    dose: "1 tablet",
    route: "oral",
    frequency: "BD",
    durationDays: 5,
    quantity,
  });

  const draft = await apiPost<{ id: string }>(
    request,
    `${api}/api/v1/prescriptions`,
    doctorToken,
    { encounterId: stay.id, lines: [line(stocked, 20), line(outOfStock, 10)] },
    site.id,
  );
  await apiPost(request, `${api}/api/v1/prescriptions/${draft.id}/sign`, doctorToken, {}, site.id);

  return {
    api,
    adminToken,
    site,
    stocked,
    outOfStock,
    prescriptionId: draft.id,
    encounterId: stay.id,
    patientName: stay.patientName,
    uhid: stay.uhid,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("the pharmacy counter", () => {
  test.beforeAll(async ({ request, baseURL }) => {
    fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
  });

  /**
   * Leave the hospital as it was found — the counter AND the waiting room.
   *
   * ── WHY THE SECOND HALF OF THIS WAS ADDED LATE, AND WHAT IT COST ──────────
   * The prescription was always cancelled; the VISIT was not, because it has to stay open while
   * the spec runs (a closed encounter drops out of the doctor's queue, and the pharmacy half needs
   * the prescription dispensable). Leaving it open at the END was an oversight with a slow fuse:
   * every run of this suite added one more patient to Dr Rao's queue, permanently.
   *
   * By the time it was noticed there were **57 of them**, the queue held 107, and `/my-patients`
   * asks for one page of 100 — so `emergencyWorkflow`'s patient had been pushed onto page two and
   * that spec failed looking for somebody who was really there. A test that quietly grows the
   * database it asserts against eventually asserts about a different hospital.
   */
  test.afterAll(async ({ request }) => {
    const headers = {
      authorization: `Bearer ${fixture.adminToken}`,
      "x-active-branch": fixture.site.id,
    };
    await request
      .post(`${fixture.api}/api/v1/prescriptions/${fixture.prescriptionId}/cancel`, {
        headers,
        data: { reason: "end of browser test — leaving the counter as it was found" },
      })
      .catch(() => undefined);
    // The visit itself, so the queue this spec borrows is the same size when it leaves.
    await request
      .post(`${fixture.api}/api/v1/encounters/${fixture.encounterId}/close`, { headers, data: {} })
      .catch(() => undefined);
  });

  /**
   * ── THE PRODUCT DECISION, IN A BROWSER ──────────────────────────────────
   * The doctor is told what the pharmacy has and is stopped by none of it.
   */
  test("shows a prescriber what is in stock, and lets them prescribe what is not", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.doctor);
    await switchToBranch(page, fixture.site.name);
    await page.goto("/my-patients");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "My patients" })).toBeVisible({
      timeout: 25_000,
    });

    // Open a patient and the prescribing pad. The pad filters, so the two drugs this run made
    // are found by their own names rather than by position in a list of hundreds.
    const mine = main.getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) });
    await expect(mine.first(), "this run's patient never reached the doctor's queue").toBeVisible({
      timeout: 25_000,
    });
    await mine.first().click();

    // The card is open for a visit under way; clicking the header would close it.
    const search = main.getByPlaceholder("Search drugs…");
    await expect(search, "the prescribing pad did not open for a visit in progress").toBeVisible({
      timeout: 20_000,
    });
    await search.fill(fixture.stocked.name);
    const stocked = main.getByRole("button", { name: new RegExp(escapeRe(fixture.stocked.name)) });
    await expect(stocked.first(), "the stocked drug was not offered on the pad").toBeVisible({
      timeout: 15_000,
    });
    await expect(
      stocked.first(),
      "the prescriber was not told how many the pharmacy has",
    ).toContainText("40 in stock");

    await search.fill(fixture.outOfStock.name);
    const out = main.getByRole("button", { name: new RegExp(escapeRe(fixture.outOfStock.name)) });
    await expect(out.first()).toBeVisible({ timeout: 15_000 });
    await expect(out.first(), "an out-of-stock drug did not say so").toContainText("out of stock");

    /**
     * THE ASSERTION THIS SPEC EXISTS FOR. The drug the hospital has none of is still offered,
     * still enabled, and still adds to the prescription — the patient buys it outside.
     */
    await expect(out.first()).toBeEnabled();
    await out.first().click();
    await expect(
      main.getByText(fixture.outOfStock.name).first(),
      "an out-of-stock drug could not be added to the prescription",
    ).toBeVisible();
  });

  /**
   * ── PARTIAL DISPENSING, AND THE REMAINDER STAYING VISIBLE ───────────────
   * Twenty prescribed, twelve handed over. The eight must not vanish: the patient buys them
   * outside or comes back, and the only way either happens is if the screen still says so.
   */
  test("dispenses part of a line and keeps the remainder on the screen", async ({ page }) => {
    await signIn(page, ACCOUNTS.pharmacist);
    await switchToBranch(page, fixture.site.name);
    await page.goto("/pharmacy");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: /Pharmacy/i })).toBeVisible({ timeout: 25_000 });

    /**
     * ── THE QUEUE IS PATIENTS, THE PANEL IS DRUGS ───────────────────────────
     * The counter's list shows one row per pharmacy ORDER — the patient, their UHID and
     * "Prescription — 2 items". The drugs are inside, which is right: a pharmacist picks the
     * person in front of them and then reads what was written for them. So this run's patient is
     * found by name, and the line by drug name once the order is open.
     *
     * `toPass` around the wait because the order is raised by the outbox consumer a moment AFTER
     * the prescription is signed — the wait is on the data arriving, never a timer.
     */
    const queueRow = main.getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) });
    await expect(async () => {
      await page.reload();
      await expect(queueRow.first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });

    await expect(main.getByText(fixture.uhid).first()).toBeVisible();
    await queueRow.first().click();

    /**
     * The line CARD: the deepest div that holds both this drug's name and its quantity box.
     * Filtering on the name alone and taking `.last()` finds the innermost match — the little row
     * holding the name and the "12/20 given" badge — which has no input in it.
     */
    const counter = main
      .locator("div")
      .filter({ hasText: fixture.stocked.name })
      .filter({ has: page.getByRole("spinbutton") })
      .last();
    await expect(counter, "the prescribed drug was not on the counter").toBeVisible({
      timeout: 15_000,
    });

    // Hand over twelve of the twenty.
    const qty = counter.getByRole("spinbutton").first();
    await qty.fill("12");
    // The Dispense button belongs to the whole handover, not to one line — a pharmacist sets the
    // quantities for every drug and then hands the lot over in one act.
    await main.getByRole("button", { name: "Dispense", exact: true }).click();

    await expect(async () => {
      const line = await lineState(page, fixture);
      expect(
        line.dispensedQty,
        "the pharmacy handed over a different quantity than it was told to",
      ).toBe(12);
    }).toPass({ timeout: 25_000 });

    // And the screen says what is still owed rather than calling it finished.
    await page.reload();
    await main
      .getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) })
      .first()
      .click();
    await expect(
      main.getByText("12/20 given"),
      "the remaining eight vanished from the counter",
    ).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText("of 8 still owed")).toBeVisible();
  });

  /**
   * The charge follows what crossed the counter, not what was written on the prescription. A
   * patient billed for twenty tablets they were given twelve of is the defect this asserts away.
   */
  test("charges for what was handed over, not what was prescribed", async ({ page, request }) => {
    await signIn(page, ACCOUNTS.pharmacist);
    const bearer = await token(request, fixture.api, ACCOUNTS.admin);

    await expect(async () => {
      const res = await request.get(
        `${fixture.api}/api/v1/encounters/${await encounterOf(page, fixture)}/charges`,
        { headers: { authorization: `Bearer ${bearer}`, "x-active-branch": fixture.site.id } },
      );
      const charges = (await res.json()) as {
        data: { code: string; quantity: number; description?: string }[];
      };
      const mine = charges.data.filter((c) => c.code === fixture.stocked.code);
      expect(mine.length, "the handover raised no charge at all").toBeGreaterThan(0);
      expect(
        mine.reduce((n, c) => n + c.quantity, 0),
        "the patient was charged for the prescribed quantity rather than the dispensed one",
      ).toBe(12);
    }).toPass({ timeout: 30_000 });
  });

  /** The shelf: the lot this run received, with its expiry, on the pharmacist's own screen. */
  test("shows the pharmacist the batch behind the stock", async ({ page }) => {
    await signIn(page, ACCOUNTS.pharmacist);
    await switchToBranch(page, fixture.site.name);
    await page.goto("/medicines");

    const main = page.getByRole("main");
    await main
      .getByPlaceholder(/Search/i)
      .first()
      .fill(fixture.stocked.name);

    const row = main.locator("tr").filter({ hasText: fixture.stocked.name }).last();
    await expect(row).toBeVisible({ timeout: 25_000 });
    await row.getByRole("button", { name: "Batches" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`B-${fixture.stocked.code.split("_").pop() ?? ""}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByText("In date")).toBeVisible();
    // Twelve were dispensed from forty, FEFO, out of the only lot there is.
    await expect(dialog.getByText("28", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/earliest expiry first/)).toBeVisible();
  });

  /** A doctor may read availability. The shelf itself — lots, quantities — is the pharmacy's. */
  test("does not open the shelf to a prescriber", async ({ page, request }) => {
    await signIn(page, ACCOUNTS.doctor);
    const bearer = await token(request, fixture.api, ACCOUNTS.doctor);
    const headers = { authorization: `Bearer ${bearer}`, "x-active-branch": fixture.site.id };

    const availability = await request.get(
      `${fixture.api}/api/v1/medicines/availability?codes=${fixture.stocked.code}`,
      { headers },
    );
    expect(availability.status(), "a doctor could not read availability").toBe(200);

    const shelf = await request.get(
      `${fixture.api}/api/v1/medicines/${fixture.stocked.code}/batches`,
      { headers },
    );
    expect(shelf.status(), "a prescriber reached the pharmacy's batch records").toBe(403);
  });
});

/** The prescription's first line, from the server — the truth the screen is checked against. */
async function lineState(
  page: Page,
  f: Fixture,
): Promise<{ quantity: number; dispensedQty: number }> {
  const res = await page.request.get(`${f.api}/api/v1/prescriptions/${f.prescriptionId}`, {
    headers: { authorization: `Bearer ${f.adminToken}`, "x-active-branch": f.site.id },
  });
  const body = (await res.json()) as {
    data: { lines: { drugCode: string; quantity: number; dispensedQty: number }[] };
  };
  const line = body.data.lines.find((l) => l.drugCode === f.stocked.code);
  expect(line, "the prescription lost the line this test wrote").toBeTruthy();
  return line!;
}

async function encounterOf(page: Page, f: Fixture): Promise<string> {
  const res = await page.request.get(`${f.api}/api/v1/prescriptions/${f.prescriptionId}`, {
    headers: { authorization: `Bearer ${f.adminToken}`, "x-active-branch": f.site.id },
  });
  const body = (await res.json()) as { data: { encounterId: string } };
  return body.data.encounterId;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
