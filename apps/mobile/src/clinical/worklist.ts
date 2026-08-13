/**
 * The nurse's worklist, as an ordering and a set of labels (M3-S3).
 *
 * ── EVERY CLINICAL NUMBER HERE CAME FROM THE SERVER ─────────────────────────
 * This file sorts and labels. It does not decide whether a dose is due, whether one is late, or
 * whether an allergy is severe — `GET /ward-worklist` resolves all three in the BRANCH's timezone
 * against real administration rows, and S1's whole design rests on the phone not having an
 * opinion about it. A handset with the wrong clock must not be able to make a patient's antibiotic
 * look on time.
 *
 * What is computed here is presentation: which row to show first, and what words go on it. There
 * is a test that scans this file for a clock read, so the boundary cannot erode quietly.
 */
import type { WorklistRow } from "@medicore/api-client";
import type { ClinicalTone } from "./encounters";

/**
 * The order a nurse walks the ward in.
 *
 * ── WHY NOT BED ORDER ───────────────────────────────────────────────────────
 * Bed order is how you walk; it is not how you triage. A round that starts at bed 1 and works
 * along finds the overdue antibiotic in bed 14 fourteen beds too late. So the list leads with what
 * is late, then what is due, and falls back to bed order for everyone who needs nothing right now
 * — which is most of the ward, most of the time, and for whom bed order is exactly right.
 *
 * Severe allergy does NOT promote a row. It is not a task; it is something to know before you act,
 * and it is carried on every row that has it rather than used to reorder the list. Sorting by it
 * would push a stable patient above a late dose.
 */
export function triageOrder(rows: readonly WorklistRow[]): WorklistRow[] {
  return [...rows].sort((a, b) => {
    if (a.dosesOverdue !== b.dosesOverdue) return b.dosesOverdue - a.dosesOverdue;
    if (a.dosesDue !== b.dosesDue) return b.dosesDue - a.dosesDue;
    return bedSortKey(a).localeCompare(bedSortKey(b), undefined, { numeric: true });
  });
}

/** `A-2` sorts before `A-10`; a row with no bed sorts last rather than first. */
function bedSortKey(row: WorklistRow): string {
  if (!row.bedCode) return "￿";
  return `${row.ward ?? ""}/${row.bedCode}`;
}

/**
 * The wards the picker may offer.
 *
 * ── IT INCLUDES THE ONE ALREADY CHOSEN, AND THAT IS THE WHOLE POINT ─────────
 * The names come from the rows the server has actually returned, so a ward with nobody in it never
 * appears — correct for a worklist. But the rows are themselves FILTERED by the chosen ward, so
 * deriving the list from them alone collapses it to one entry the moment a nurse picks a ward, and
 * a picker with one option is a picker that gets hidden. That left the nurse on a single ward with
 * no way back to "All wards" until they killed the app. The selection is unioned back in so the
 * list can never shrink below "here is where you are, and here is the way out".
 */
export function wardOptions(
  rows: readonly { ward?: string }[],
  selected: string | undefined,
): string[] {
  const names = new Set<string>();
  for (const row of rows) if (row.ward) names.add(row.ward);
  if (selected) names.add(selected);
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface WorklistFlag {
  label: string;
  tone: ClinicalTone;
  /**
   * Spoken by a screen reader in place of the pill. Colour and a short label are not enough on
   * their own, and "2 overdue" read aloud without the word "doses" is ambiguous.
   */
  accessibilityLabel: string;
}

/**
 * The pills on one row, in the order they should be read.
 *
 * Each carries its own words. Nothing here is communicated by colour alone: "Overdue" says
 * overdue, "Allergy" says allergy, and the tone only reinforces what the text already states.
 */
export function flagsFor(row: WorklistRow): WorklistFlag[] {
  const flags: WorklistFlag[] = [];

  if (row.dosesOverdue > 0) {
    flags.push({
      label: `${String(row.dosesOverdue)} overdue`,
      tone: "critical",
      accessibilityLabel: `${String(row.dosesOverdue)} medication ${plural(
        row.dosesOverdue,
        "dose",
      )} overdue`,
    });
  }

  // Only the doses NOT already counted as overdue, or the row reads as double-counting: a patient
  // with three due of which two are late must not present as five outstanding doses.
  const stillDue = row.dosesDue - row.dosesOverdue;
  if (stillDue > 0) {
    flags.push({
      label: `${String(stillDue)} due`,
      tone: "warning",
      accessibilityLabel: `${String(stillDue)} medication ${plural(stillDue, "dose")} due today`,
    });
  }

  if (row.allergens.length > 0) {
    flags.push({
      label: row.severeAllergy ? "Severe allergy" : "Allergy",
      tone: row.severeAllergy ? "critical" : "warning",
      accessibilityLabel: row.severeAllergy
        ? `Severe allergy recorded: ${row.allergens.join(", ")}`
        : `Allergy recorded: ${row.allergens.join(", ")}`,
    });
  }

  /**
   * The SERVER's `abnormal` on the last reading (M3-S4) — the same `assess()` the chart paints,
   * never re-derived from the values. Last, because an out-of-range observation already charted is
   * context for the round rather than a task on it: the doses are what is outstanding.
   */
  if (row.vitalsAbnormal) {
    flags.push({
      label: "Obs out of range",
      tone: "warning",
      accessibilityLabel: "Last observations were outside the reference range",
    });
  }

  return flags;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

/**
 * Where the patient is, for the row's second line.
 *
 * The worklist carries the bed recorded AT ADMISSION, which is free text. `/bed-board` has the
 * catalogue version and the round screen prefers it — but this list does not fetch the board for
 * placement, so it shows what the admission says and says nothing it does not know.
 */
export function bedLabel(row: WorklistRow): string {
  if (row.ward && row.bedCode) return `${row.ward} · ${row.bedCode}`;
  if (row.ward) return row.ward;
  return "Bed not recorded";
}

/**
 * "Nothing due" is a real answer and must look like one.
 *
 * An empty flag row could mean "this patient needs nothing" or "we could not load it". The
 * worklist says the first explicitly, because a nurse skipping a patient on the strength of a
 * blank is the failure mode that matters.
 *
 * Derived from `flagsFor` rather than from a second list of conditions, so a flag added later
 * cannot leave a row saying "nothing due" underneath a pill that says otherwise.
 */
export function quietLabel(row: WorklistRow): string | undefined {
  return flagsFor(row).length === 0 ? "Nothing due" : undefined;
}

/**
 * When observations were last charted, as words (M3-S4).
 *
 * ── IT SAYS WHEN, AND NEVER WHETHER THEY ARE OVERDUE ────────────────────────
 * There is no observation-frequency order anywhere in this product, so nothing — here or on the
 * server — knows how often this patient is meant to be observed. A worklist that decided
 * four-hourly was the rule would mark a stable post-op patient late on a ward that observes twelve
 * hourly, and a nurse who learns the app cries wolf stops reading it. The time is stated; the
 * judgement stays with the person doing the round.
 *
 * `formatted` is passed in because turning an instant into "Today 14:05" needs the ward's zone and
 * the ward's today, and this module holds no clock — the same rule as the rest of the file.
 */
export function observationsLabel(row: WorklistRow, formatted: string | undefined): string {
  if (!row.latestVitalsAt) return "No observations on this stay";
  return formatted ? `Obs ${formatted}` : "Observations recorded";
}
