/**
 * The medication round, as an ordering and a set of labels (M3-S5B).
 *
 * ── THIS FILE IS A NAVIGATOR. IT DECIDES NOTHING CLINICAL ───────────────────
 * Every dose state on the round is the SERVER's, resolved in the ward's timezone against real
 * administration rows. Nothing here computes whether a dose is due, whether it is late, which day
 * it is, or whether a drug is safe for a patient. What it computes is presentation: which patient
 * to walk to first, what words go on a row, and how to say "nothing outstanding" so that it cannot
 * be mistaken for "we could not load it".
 *
 * ── AND IT NEVER WRITES ─────────────────────────────────────────────────────
 * The round hands the confirmation screen a slot IDENTITY and gets out of the way. There is no
 * Give here, no bulk action, no local status flip after one — S5A proved the exact patient, the
 * exact line, the exact slot, the idempotency key, the 409 reconciliation and the duplicate
 * protection, and every one of those would have to be proved again on a scrolling list. A tap
 * target beside twelve other tap targets is how the wrong patient gets the wrong drug.
 *
 * There is a test that scans this file for a clock read and for a write, so neither boundary can
 * erode quietly.
 */
import type { DoseSlot, MedicationRoundRow } from "@medicore/api-client";
import type { ClinicalTone } from "./encounters";

/**
 * ── THE IDENTITY CONSTRUCTOR IS SHARED; THE PREDICATE BELOW IS NOT ──────────
 * `slotRef` moved to the client package when the WEB round needed it too (W4): which three fields
 * name a dose is the API's own vocabulary, and two hand-written copies of that literal is how one
 * surface quietly starts sending `drugCode`.
 *
 * `isOutstanding` deliberately stayed. It reads as the same candidate for sharing — and the guard
 * at the bottom of `medication-round.test.ts` is why it should not be: that test asserts this file
 * compares against exactly `due` and `overdue` and nothing else, which is how it proves the round
 * re-derives no clinical state. Importing the predicate would empty the guard of its subject while
 * leaving it green, trading a tested boundary for a cosmetic de-duplication.
 */
export { slotRef } from "@medicore/api-client";

/** A slot nobody has answered. The SERVER's two derived states, never re-derived here. */
export function isOutstanding(slot: Pick<DoseSlot, "state">): boolean {
  return slot.state === "due" || slot.state === "overdue";
}

/**
 * The order a nurse walks the round in.
 *
 * ── LATE FIRST, THEN SOONEST DUE, THEN BED ──────────────────────────────────
 * S3 established the principle and this sharpens it: bed order finds the overdue antibiotic in bed
 * 14 fourteen beds too late, so the patient with the earliest OUTSTANDING dose leads. That single
 * rule gives overdue-before-due for free — an overdue dose is by definition scheduled earlier than
 * one still due — without the round holding an opinion about which is which.
 *
 * Everyone with nothing outstanding falls to the bottom in bed order, which is exactly right for
 * them: they are not work, and bed order is how you walk to a patient you do need to see.
 *
 * A severe allergy does NOT promote a row. It is not a task; it is something to know before you
 * act, and it is carried on every row that has it. Sorting by it would push a stable patient above
 * a late dose.
 */
export function roundOrder(rows: readonly MedicationRoundRow[]): MedicationRoundRow[] {
  return [...rows].sort((a, b) => {
    const first = earliestOutstanding(a);
    const other = earliestOutstanding(b);
    if (first !== other) {
      if (first === undefined) return 1;
      if (other === undefined) return -1;
      // ISO-8601 instants sort correctly as strings; no clock and no parsing involved.
      return first.localeCompare(other);
    }
    return bedSortKey(a).localeCompare(bedSortKey(b), undefined, { numeric: true });
  });
}

/** When this patient's next unanswered dose was scheduled, or `undefined` if none is. */
export function earliestOutstanding(row: MedicationRoundRow): string | undefined {
  let earliest: string | undefined;
  for (const slot of row.slots) {
    if (!isOutstanding(slot)) continue;
    if (earliest === undefined || slot.scheduledFor < earliest) earliest = slot.scheduledFor;
  }
  return earliest;
}

/** `A-2` sorts before `A-10`; a row with no bed sorts last rather than first. */
function bedSortKey(row: MedicationRoundRow): string {
  if (!row.bedCode) return "￿";
  return `${row.ward ?? ""}/${row.bedCode}`;
}

/**
 * The doses on one row, in the order they are worked.
 *
 * Earliest first, and a tie is broken by drug name so that two drugs on the same round have a
 * stable order between renders — a list that reshuffles under a thumb is a list somebody taps the
 * wrong row on.
 */
export function slotOrder(slots: readonly DoseSlot[]): DoseSlot[] {
  return [...slots].sort(
    (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.drugName.localeCompare(b.drugName),
  );
}

/** A key that is unique per dose across the whole round — the slot identity, spelled out. */
export function slotKey(slot: DoseSlot): string {
  return `${slot.prescriptionId}:${String(slot.lineIndex)}:${slot.scheduledFor}`;
}

/* ── words ─────────────────────────────────────────────────────────────────── */

export interface RoundFlag {
  label: string;
  tone: ClinicalTone;
  /** Spoken in place of the pill. Colour and a short label are never enough on their own. */
  accessibilityLabel: string;
}

/**
 * The pills on a patient's header, in the order they should be read.
 *
 * The counts are the SERVER's `dosesDue` / `dosesOverdue`, not a tally of the slots on screen: the
 * two agree by construction, and reading the server's number keeps the "no local clinical
 * arithmetic" rule true even for something as innocent as a count.
 */
export function roundFlags(row: MedicationRoundRow): RoundFlag[] {
  const flags: RoundFlag[] = [];

  if (row.dosesOverdue > 0) {
    flags.push({
      label: `${String(row.dosesOverdue)} overdue`,
      tone: "critical",
      accessibilityLabel: `${String(row.dosesOverdue)} ${plural(row.dosesOverdue, "dose")} overdue`,
    });
  }

  // Only the doses NOT already counted as overdue, or the row reads as double-counting: three due
  // of which two are late must not present as five outstanding doses.
  const stillDue = row.dosesDue - row.dosesOverdue;
  if (stillDue > 0) {
    flags.push({
      label: `${String(stillDue)} due`,
      tone: "warning",
      accessibilityLabel: `${String(stillDue)} ${plural(stillDue, "dose")} still due`,
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

  return flags;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

/**
 * Where the patient is. Second line of the header, never the primary identifier.
 *
 * A bed is where somebody was an hour ago; the wristband is what the nurse checks against. So the
 * bed is context and the NAME plus UHID lead — which is why the round endpoint resolves both
 * server-side rather than leaving them to an enrichment that can be missing.
 */
export function bedLabel(row: Pick<MedicationRoundRow, "ward" | "bedCode">): string {
  if (row.ward && row.bedCode) return `${row.ward} · ${row.bedCode}`;
  if (row.ward) return row.ward;
  return "Bed not recorded";
}

/**
 * What a patient's row says when nothing on it is outstanding.
 *
 * ── FOUR STATES THAT LOOK ALIKE AND MEAN DIFFERENT THINGS ───────────────────
 * "no doses today", "every dose answered", "one held, nothing outstanding" and "we could not load
 * this" are four different facts, and only the last is a failure. A blank row would collapse all
 * four, and the one that matters — a nurse skipping a patient because the row looked empty — is
 * the reason this returns words instead of nothing. Loading and error states are the SCREEN's job;
 * this only ever speaks about data it actually has.
 */
export function quietLabel(row: MedicationRoundRow): string | undefined {
  if (row.dosesDue > 0) return undefined;
  if (row.slots.length === 0) return "No scheduled doses today";
  return "All doses answered";
}

/**
 * The round's headline: what is still outstanding across the patients LOADED so far.
 *
 * `complete` is what keeps it honest. A round is paged, and a summary taken from page one of three
 * would understate the ward's outstanding work — a nurse reading "2 doses due" and stopping is the
 * failure. When more pages remain the screen says so in words rather than quietly counting less.
 */
export interface RoundSummary {
  patients: number;
  due: number;
  overdue: number;
  complete: boolean;
}

export function summariseRound(
  rows: readonly MedicationRoundRow[],
  total: number | undefined,
): RoundSummary {
  let due = 0;
  let overdue = 0;
  for (const row of rows) {
    due += row.dosesDue;
    overdue += row.dosesOverdue;
  }
  return {
    patients: rows.length,
    due,
    overdue,
    complete: total === undefined || rows.length >= total,
  };
}

/** The summary as a sentence — the same words on screen and in the screen reader. */
export function summaryLabel(summary: RoundSummary): string {
  const { due, overdue, patients, complete } = summary;
  const scope = complete
    ? `${String(patients)} ${plural(patients, "patient")}`
    : `${String(patients)} of more patients loaded`;

  if (due === 0)
    return complete ? `Nothing outstanding · ${scope}` : `Nothing outstanding yet · ${scope}`;
  const late = overdue > 0 ? `, ${String(overdue)} overdue` : "";
  return `${String(due)} ${plural(due, "dose")} outstanding${late} · ${scope}`;
}
