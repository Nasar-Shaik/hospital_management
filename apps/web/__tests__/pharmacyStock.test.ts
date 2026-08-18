import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PHARMACY v1 ON THE WEB — asserted on source, because the rules here are about what is SHOWN
 * and, more importantly, what is not ALLOWED to be shown as a restriction.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The one this milestone's product decision exists to prevent: availability quietly becoming a
 * gate. It is one line — `disabled={stock[d.code]?.units === 0}` — and it reads like a kindness.
 * It would mean a doctor cannot prescribe a drug the hospital is out of, so the patient who would
 * have bought it at the shop next door goes home without a prescription for it at all.
 *
 * And the mirror image on the pharmacist's side: a shelf view that hides expired stock. Expired
 * lots are already excluded from every dispensing path; the pharmacist is the one person who
 * MUST still see them, because somebody has to pull the box.
 */
const PAD = readFileSync(join(__dirname, "..", "app/my-patients/page.tsx"), "utf8");
const SHELF = readFileSync(join(__dirname, "..", "app/medicines/page.tsx"), "utf8");

describe("availability informs the prescriber and never restricts them", () => {
  it("shows how many units the pharmacy has", () => {
    expect(PAD).toMatch(/medicineAvailability\(/);
    expect(PAD).toMatch(/in stock/);
  });

  /** In WORDS, not a colour or a disabled control — the doctor has to tell the patient. */
  it("says out of stock in words", () => {
    expect(PAD).toMatch(/out of stock/);
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR. No control on the prescribing pad may be disabled,
   * hidden or filtered because of stock.
   */
  it("never turns availability into a restriction", () => {
    const suspicious = [
      /disabled=\{[^}]*stock\[/,
      /units\s*===?\s*0\s*\?\s*null/,
      /units\s*>\s*0\s*&&\s*</,
      /filter\([^)]*units/,
    ];
    for (const pattern of suspicious) {
      expect(
        PAD,
        `stock is being used to restrict prescribing (${String(pattern)}). Availability is ` +
          `information: a doctor prescribes what the patient needs and the patient buys it ` +
          `outside if the hospital is out.`,
      ).not.toMatch(pattern);
    }
  });

  /** A pending lookup must not read as an empty pharmacy. */
  it("shows nothing at all until the lookup has answered", () => {
    expect(PAD).toMatch(/if \(!of\) return null;/);
  });

  /** The pad must not become an inventory screen: no cost, no reorder level, no batch numbers. */
  it("does not put pharmacy accounting in front of a prescriber", () => {
    const availabilityBlock = PAD.slice(
      PAD.indexOf("function Availability("),
      PAD.indexOf("function add("),
    );
    for (const leak of ["reorderLevel", "batchNo", "price", "cost"]) {
      expect(availabilityBlock, `the prescribing pad exposed \`${leak}\``).not.toContain(leak);
    }
  });
});

describe("the pharmacist's shelf shows what has to be pulled", () => {
  it("lists batches with their expiry and remaining quantity", () => {
    expect(SHELF).toMatch(/medicineBatches\(/);
    expect(SHELF).toMatch(/Remaining/);
  });

  it("shows expired lots rather than hiding them", () => {
    expect(SHELF).toMatch(/Expired — pull and write off/);
    // And does not filter them out of the list it renders.
    expect(SHELF).not.toMatch(/batches\.filter\([^)]*expired/);
  });

  it("distinguishes near expiry from in date", () => {
    expect(SHELF).toMatch(/Near expiry/);
    expect(SHELF).toMatch(/In date/);
  });

  /** A pharmacy with no batches is a normal state, not an error or an empty table. */
  it("explains an unbatched pharmacy rather than showing nothing", () => {
    expect(SHELF).toMatch(/No batches recorded/);
    expect(SHELF).toMatch(/running total/);
  });

  it("tells the pharmacist the rule dispensing actually follows", () => {
    expect(SHELF).toMatch(/earliest expiry first/);
  });

  /** The receive form must ask for the pair, since the server refuses one without the other. */
  it("asks for a batch number and an expiry together", () => {
    expect(SHELF).toMatch(/batch number <strong>and<\/strong> an expiry date/);
  });
});
