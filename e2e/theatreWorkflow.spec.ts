import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * Theatre v1, through a browser.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * `theatres.int.test.ts` proves the rules — the overlap, the state machine, the write-once record,
 * every boundary. None of that can fail the way this can.
 *
 * What a browser is the only witness to: a surgeon who holds `ot:schedule` and still sees no "Book
 * a procedure" button, because the page asked for a permission the role does not hold (this is a
 * REAL defect class here — `nursing:manage` hid behind it for two milestones); the 409 the overlap
 * rule returns arriving as a silent no-op instead of a sentence the coordinator can act on; and
 * the operation record, which is the whole point of this milestone, having no door in the building.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Two things could make this suite pass on stale data, and both are closed here:
 *
 *   THE THEATRE is a single dedicated room (`E2EOT`), created once and reused. A room per run
 *   would grow the registry forever; a run that picked "whatever theatre is there" would collide
 *   with a coordinator's real list the moment this ran against a demo hospital somebody uses.
 *
 *   THE ROOM IS CLEARED FIRST. A booking holds its window while it is `scheduled` or
 *   `in_progress` and releases it on any terminal state, so a run that finishes leaves nothing
 *   behind — but a run that DIES halfway leaves a booking occupying the slot, and the next run is
 *   then refused its own first booking. That happened: a clock-derived slot repeated, landed on an
 *   abandoned booking, and the failure read as "the overlap rule is broken" when the rule was the
 *   only thing working. So the spec cancels anything still holding a window in its own dedicated
 *   room before it starts, and books a FIXED slot — deterministic by construction rather than by
 *   hoping two runs never coincide.
 *
 *   EVERY LOCATOR is anchored on THIS RUN'S procedure name. `.first()` on a board that accumulates
 *   a row per run would eventually assert against a previous run's booking — which is exactly the
 *   failure mode that makes a green suite worthless.
 */

interface Stay {
  id: string;
  patientName: string;
  uhid: string;
}

interface Theatre {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface Doctor {
  id: string;
  name: string;
}

interface Booking {
  id: string;
  status: string;
  procedureName: string;
}

interface Fixture {
  /** The site the theatre lives at — a booking is a WRITE, and a write needs one site chosen. */
  siteName: string;
  theatreName: string;
  patientName: string;
  uhid: string;
  /**
   * The surgeon's ID, not their label. `GET /doctors` renders "Dr Rao (General Medicine)" — the
   * specialty is appended for the human reading the dropdown, so a fixture holding "Dr Rao" fails
   * an exact-label match and a fixture holding the full string breaks the day somebody edits a
   * department name. The id is the thing the form actually posts.
   */
  surgeonId: string;
  procedure: string;
  /** `YYYY-MM-DD` — the board's date picker, and the day both bookings live on. */
  day: string;
  start: string;
  end: string;
  /** Overlaps `start..end` by design: the refusal this suite exists to see. */
  clashStart: string;
  clashEnd: string;
}

/** The dedicated room. Stable so the registry does not grow by one row per run. */
const THEATRE_CODE = "E2EOT";
const THEATRE_NAME = "E2E Theatre";

let fixture: Fixture;

/** `YYYY-MM-DDTHH:mm` — what `<input type="datetime-local">` accepts and reads back. */
function localStamp(day: string, minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${day}T${h}:${m}`;
}

/**
 * The room and the patient, over HTTP.
 *
 * The theatre registry is estate configuration behind `facility:manage`, which the surgeon does not
 * hold and should not — arranging it through the UI would mean a second sign-in as the admin to
 * test a screen that is not the subject. The BOOKING, which is the subject, is made in the browser.
 */
async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const adminToken = await token(request, api, ACCOUNTS.admin);

  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const site = open[0]!;

  const theatres = await apiGet<Theatre[]>(request, `${api}/api/v1/theatres`, adminToken, site.id);
  let theatre = theatres.find((t) => t.code === THEATRE_CODE);
  if (!theatre) {
    theatre = await apiPost<Theatre>(
      request,
      `${api}/api/v1/theatres`,
      adminToken,
      { name: THEATRE_NAME, code: THEATRE_CODE, kind: "major_ot" },
      site.id,
    );
  }
  expect(theatre.status, "the E2E theatre has been retired — reactivate or drop it").toBe("active");

  const stays = await apiGet<Stay[]>(
    request,
    `${api}/api/v1/inpatients?limit=20`,
    adminToken,
    site.id,
  );
  expect(
    stays.length,
    `no admitted patient at ${site.name} to book a procedure for — run pnpm seed:validation`,
  ).toBeGreaterThan(0);
  // Rotated by the clock, for the same reason the radiology spec rotates: eight runs on one chart
  // is how that suite started cutting its own newest rows off.
  const stay = stays[Math.floor(Date.now() / 1000) % stays.length]!;

  const doctors = await apiGet<Doctor[]>(request, `${api}/api/v1/doctors`, adminToken, site.id);
  const surgeon = doctors.find((d) => /Rao/.test(d.name));
  expect(surgeon, "the doctor this suite signs in as is not in the doctor list").toBeTruthy();

  const now = new Date();
  const day = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  /**
   * ── CLEAR THE ROOM ────────────────────────────────────────────────────────
   * Only bookings still HOLDING a window matter: `completed` and `cancelled` release theirs, so a
   * run that finished leaves nothing to clean and previous runs' history stays on the board where
   * a demo hospital wants it. This cancels only what a crashed run abandoned, and only in this
   * spec's own room.
   */
  const wide = `from=${day}T00:00:00.000Z&to=${day}T23:59:59.000Z`;
  const existing = await apiGet<Booking[]>(
    request,
    `${api}/api/v1/ot-bookings?theatreId=${theatre.id}&${wide}`,
    adminToken,
    site.id,
  );
  for (const b of existing.filter((x) => x.status === "scheduled" || x.status === "in_progress")) {
    await apiPost(
      request,
      `${api}/api/v1/ot-bookings/${b.id}/transition`,
      adminToken,
      { to: "cancelled", reason: "abandoned by an interrupted e2e run" },
      site.id,
    );
  }

  /**
   * A FIXED slot, safe because the room was just cleared. A clock-derived one repeated every
   * twenty minutes of wall time and its half-hour windows overlapped between consecutive runs —
   * the very thing the spec then blamed on the product. Early morning so neither the window nor
   * its deliberate overlap can cross midnight into a day the board is not showing.
   */
  const base = 8 * 60;
  const run = String(Date.now()).slice(-6);

  return {
    siteName: site.name,
    theatreName: THEATRE_NAME,
    patientName: stay.patientName,
    uhid: stay.uhid,
    surgeonId: surgeon!.id,
    procedure: `E2E appendectomy ${run}`,
    day,
    start: localStamp(day, base),
    end: localStamp(day, base + 30),
    clashStart: localStamp(day, base + 10),
    clashEnd: localStamp(day, base + 40),
  };
}

/** The board row for THIS run's procedure. Never `.first()` — see the header. */
function bookingRow(page: Page, procedure: string) {
  return page.getByRole("row").filter({ hasText: procedure });
}

async function openBookingForm(page: Page, f: Fixture, procedure: string): Promise<void> {
  await page.getByRole("button", { name: "Book a procedure" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByText("Book a procedure")).toBeVisible();

  await modal
    .getByRole("combobox")
    .first()
    .selectOption({ label: `${f.theatreName} (${THEATRE_CODE})` });

  // The patient is found by UHID, which is unique — a name search could match a namesake.
  await modal.getByPlaceholder("Search name or UHID").fill(f.uhid);
  await modal.getByRole("button", { name: "Search", exact: true }).click();
  await modal.getByRole("button", { name: new RegExp(f.uhid) }).click();
  await expect(modal.getByText(f.uhid)).toBeVisible();

  await modal.getByRole("combobox").nth(1).selectOption(f.surgeonId);
  await modal.getByLabel("Procedure", { exact: true }).fill(procedure);
}

test.beforeAll(async ({ request, baseURL }) => {
  fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
});

/**
 * Serial, and it says so. The reader test asserts against the row the surgeon test creates; a
 * parallel run would have it looking for a booking that does not exist yet, and the honest fix is
 * to declare the dependency rather than have the second test re-book what the first already proved.
 */
test.describe.serial("the operating theatre, from the list to the chart", () => {
  test("a surgeon books a procedure, is refused an overlap, runs it and writes it up", async ({
    page,
  }) => {
    const f = fixture;

    /* ── 1. the board ────────────────────────────────────────────────────── */
    await signIn(page, ACCOUNTS.doctor);
    /**
     * ── A BOOKING IS A WRITE, AND A WRITE NEEDS A SITE ──────────────────────
     * The header defaults to "All branches", which is an aggregate READ mode: a new record has no
     * site to be stamped with, so the API answers HMS-BRANCH-001. That is correct behaviour and
     * the same rule every other branch-stamped write follows — it is included here because the
     * error arrives INSIDE the modal, and a suite that never selected a site would report it as
     * "the booking form is broken".
     */
    await switchToBranch(page, f.siteName);
    await page.goto("/theatres");
    await expect(page.getByRole("heading", { name: "Operation theatres" })).toBeVisible();

    // The permission gate, seen from the surgeon's side. Before this milestone `ot:schedule` was
    // held by no clinical role and this button did not exist for any doctor in the building.
    const bookButton = page.getByRole("button", { name: "Book a procedure" });
    await expect(bookButton, "the surgeon cannot see the booking control").toBeVisible();

    /* ── 2. book it ──────────────────────────────────────────────────────── */
    await openBookingForm(page, f, f.procedure);
    const modal = page.getByRole("dialog");
    await modal.getByLabel("Start").fill(f.start);
    await modal.getByLabel("End").fill(f.end);
    await modal.getByRole("button", { name: "Book procedure" }).click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    /* ── 3. and see it on the day's list ─────────────────────────────────── */
    const row = bookingRow(page, f.procedure);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText(f.patientName);
    await expect(row).toContainText(f.theatreName);
    await expect(row).toContainText("scheduled");

    /* ── 4. the collision rule, in words the coordinator can act on ──────── */
    const clash = `E2E clash ${String(Date.now()).slice(-6)}`;
    await openBookingForm(page, f, clash);
    await modal.getByLabel("Start").fill(f.clashStart);
    await modal.getByLabel("End").fill(f.clashEnd);
    await modal.getByRole("button", { name: "Book procedure" }).click();

    // The refusal is the assertion: the modal STAYS open, carrying a sentence naming the clash.
    await expect(modal.getByText(/already booked for this window/i)).toBeVisible({
      timeout: 15_000,
    });
    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toHaveCount(0);
    // …and nothing was created. A 409 that still wrote a row would look identical above.
    await expect(bookingRow(page, clash)).toHaveCount(0);

    /* ── 5. start, and complete ──────────────────────────────────────────── */
    await row.getByRole("button", { name: "Start" }).click();
    await expect(row).toContainText("in progress", { timeout: 15_000 });

    /* ── 6. the operation record — the thing this milestone is for ───────── */
    await row.getByRole("button", { name: "Record operation" }).click();
    await expect(modal.getByText("Record the operation")).toBeVisible();
    // The surgeon is told it cannot be undone BEFORE they write it, not after.
    await expect(modal.getByText(/written once/i)).toBeVisible();

    await modal.getByLabel("Procedure performed").fill(`Laparoscopic ${f.procedure}`);
    await modal.getByRole("combobox").selectOption(f.surgeonId);
    await modal.getByLabel("Findings").fill("Inflamed appendix, no perforation.");
    await modal.getByRole("button", { name: "Save operation record" }).click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    await row.getByRole("button", { name: "Complete" }).click();
    await expect(row).toContainText("completed", { timeout: 15_000 });

    /* ── 7. and it reads back, after the procedure closed ────────────────── */
    await row.getByRole("button", { name: "Operation record" }).click();
    await expect(modal.getByText("Operation record")).toBeVisible();
    await expect(modal.getByText(`Laparoscopic ${f.procedure}`)).toBeVisible();
    await expect(modal.getByText("Inflamed appendix, no perforation.")).toBeVisible();
    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toHaveCount(0);
  });

  test("a reader without ot:record sees the record but cannot author one", async ({ page }) => {
    /**
     * The pharmacist holds `emr:read` and neither OT permission. The claim is not "the button is
     * hidden" — a hidden button is not a security control and the API proves the refusal — it is
     * that the SCHEDULE is still readable. A screen that answered 403 to everyone without
     * `ot:schedule` would take the surgical list away from every ward that needs to see it.
     */
    await signIn(page, ACCOUNTS.pharmacist);
    await switchToBranch(page, fixture.siteName);
    await page.goto("/theatres");
    await expect(page.getByRole("heading", { name: "Operation theatres" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Book a procedure" })).toHaveCount(0);

    const row = bookingRow(page, fixture.procedure);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row.getByRole("button", { name: "Start" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Operation record" })).toBeVisible();
  });
});
