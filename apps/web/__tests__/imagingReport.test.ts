import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE IMAGING RESULT FORM — asserted on the source, because the rule is which fields are SHOWN.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The worklist serves lab and imaging from one component, which is right — it is one order and one
 * `complete` call. What it must not do is ask the same questions of both. A radiographer shown
 * "Haemoglobin / 11.9 / g/dL / 12–15" is being asked to file a chest X-ray as a blood count, and
 * the likely outcome is that the narrative goes in the wrong box or does not get typed at all.
 *
 * It would also catch the quieter one: `GET /lab-tests/:code` is gated on `module.clinical.lis`,
 * so firing it for an imaging order at a hospital that bought RIS and not LIS is a request that
 * can only ever answer HMS-PLAN-002. Swallowed, it looks like nothing; it is a doomed call in the
 * access log of every imaging study the hospital ever performs.
 */
const WORKLIST = readFileSync(join(__dirname, "..", "app/worklist/page.tsx"), "utf8");

describe("the result form knows an X-ray from a blood count", () => {
  it("decides from the order's category, not from its code or name", () => {
    // A code-sniffing rule ("starts with XRAY") breaks the first time a hospital renames a study.
    expect(WORKLIST).toMatch(/const imaging = order\.category === "radiology"/);
  });

  it("asks an imaging study for findings and an impression", () => {
    expect(WORKLIST).toMatch(/Report — findings and impression/);
    // And gives the prose room: a two-row box invites one line where a report needs a paragraph.
    expect(WORKLIST).toMatch(/rows=\{imaging \? 6 : 2\}/);
  });

  /**
   * COLLAPSED, not removed. A chest X-ray has no numbers; an obstetric ultrasound has BPD, FL and
   * EFW. Deleting the grid for imaging would make the second case unrecordable, so the common case
   * is the default and the other is one click.
   */
  it("collapses the values grid for imaging rather than deleting it", () => {
    expect(WORKLIST).toMatch(/<details open=\{!imaging\}>/);
    expect(WORKLIST).toMatch(/Measurements — most studies have none/);
  });

  it("does not ask the lab catalogue about a study that has no analytes", () => {
    expect(WORKLIST).toMatch(/if \(order\.category !== "lab"\) return;/);
  });

  /** The alert is the same mechanism; only the word changes, because imaging sees rather than measures. */
  it("keeps the critical alert, in imaging's language", () => {
    expect(WORKLIST).toMatch(/imaging \? "Critical finding" : "Critical value"/);
    expect(WORKLIST).toMatch(/tension pneumothorax/);
  });

  /**
   * The narrative is submitted through the SAME `completeOrder` call the lab uses. A second write
   * path for imaging is how the two would drift, and there is nothing radiology needs that
   * `summary` does not already carry.
   */
  it("submits through the one existing complete call", () => {
    expect(WORKLIST).toMatch(/api\.completeOrder\(order\.id, \{/);
    expect(WORKLIST).not.toMatch(/completeRadiologyOrder|submitImagingReport/);
  });
});

describe("the imaging worklist is the same worklist", () => {
  it("is a tab on the shared screen, not a second page", () => {
    expect(WORKLIST).toMatch(/\{ label: "X-ray & imaging", category: "radiology" \}/);
  });

  /** Every row carries what the console needs; nothing radiology-specific was added to get it. */
  it("shows the patient, the study, the priority, the status and the payment state", () => {
    for (const field of [
      "patientName",
      "uhid",
      "o.name",
      "o.priority",
      "o.status",
      "PaymentBadge",
    ]) {
      expect(WORKLIST, `the worklist row lost ${field}`).toContain(field);
    }
  });
});
