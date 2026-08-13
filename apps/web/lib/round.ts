/**
 * The medication round, as an ordering and a set of labels (W4).
 *
 * ── THIS FILE IS A NAVIGATOR. IT DECIDES NOTHING CLINICAL ───────────────────
 * Every dose state on the round is the SERVER's, resolved in the ward's timezone against real
 * administration rows. Nothing here computes whether a dose is due, whether it is late, which day
 * it is, or whether a drug is safe for a patient. What it computes is presentation: which patient
 * to walk to first, what words go on a row, and how to say "nothing outstanding" so that it cannot
 * be mistaken for "we could not load it".
 *
 * ── AND IT NEVER WRITES ─────────────────────────────────────────────────────
 * The round hands the administration screen a slot IDENTITY and gets out of the way. There is no
 * Give here, no bulk action, no local status flip after one. W3 proved the exact patient, the exact
 * line, the exact slot, the idempotency key, the 409 reconciliation and the duplicate protection,
 * and every one of those would have to be proved again on a scrolling list. A button beside twelve
 * other buttons is how the wrong patient gets the wrong drug.
 *
 * There are tests that scan this file for a clock read and for a write, so neither boundary can
 * erode quietly.
 *
 * ── WHY THIS IS A WEB COPY OF MOBILE'S `src/clinical/round.ts` ──────────────
 * The contract-level pieces are NOT copied — `isSlotOpen` and `slotRef` are imported from the
 * client package, because "which states are open" and "which three fields name a dose" are the
 * API's vocabulary and must have one definition (W3 established that, and `slotRef` moved there
 * for this slice). What is copied is the ORDERING and the WORDS, and those are presentation: a
 * phone speaks to a thumb at a bedside and this speaks to a keyboard at a station. The rule they
 * share — late first, then soonest due, then bed — is small, stated below, and pinned by tests on
 * both sides rather than by a shared function neither owns.
 */
import { isSlotOpen, type DoseSlot, type MedicationRoundRow } from "@medicore/api-client";

/**
 * The order a nurse walks the round in.
 *
 * ── LATE FIRST, THEN SOONEST DUE, THEN BED ──────────────────────────────────
 * Bed order finds the overdue antibiotic in bed 14 fourteen beds too late, so the patient with the
 * earliest OUTSTANDING dose leads. That single rule gives overdue-before-due for free — an overdue
 * dose is by definition scheduled earlier than one still due — without the round holding an
 * opinion about which is which, and therefore without inventing a clinical priority of its own.
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
    if (!isSlotOpen(slot)) continue;
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
 * Earliest first, and a tie is broken by drug name so that two drugs at the same time have a stable
 * order between renders — a list that reshuffles under a cursor is a list somebody clicks the wrong
 * row on.
 */
export function slotOrder(slots: readonly DoseSlot[]): DoseSlot[] {
  return [...slots].sort(
    (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.drugName.localeCompare(b.drugName),
  );
}

/** A key unique per dose across the whole round — the slot identity, spelled out. */
export function slotKey(slot: DoseSlot): string {
  return `${slot.prescriptionId}:${String(slot.lineIndex)}:${slot.scheduledFor}`;
}

/* ── words ─────────────────────────────────────────────────────────────────── */

export type RoundTone = "critical" | "warning" | "neutral" | "success";

export interface RoundFlag {
  label: string;
  tone: RoundTone;
  /**
   * Read in place of the pill. Colour and a three-word label are never enough on their own — a
   * red chip saying "2 overdue" is invisible to a screen reader and ambiguous to a colour-blind
   * nurse, and this is the sentence that carries the meaning instead.
   */
  accessibilityLabel: string;
}

/**
 * The pills on a patient's row, in the order they should be read.
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
 * Where the patient is. Second line of the row, never the primary identifier.
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
 * How ONE dose reads, without colour.
 *
 * ── THE STATE IS THE SERVER'S WORD, TRANSLATED, NEVER RECOMPUTED ────────────
 * `due` and `overdue` are derived by the API from the ward's clock; the other four are recorded
 * facts. This maps the six to text and a tone, and a test asserts that the only `state` literals
 * in this file are those six — so nobody can slip in a `Date.now()` comparison and call it late.
 */
export function doseStateLabel(slot: Pick<DoseSlot, "state">): { text: string; tone: RoundTone } {
  switch (slot.state) {
    case "overdue":
      return { text: "Overdue", tone: "critical" };
    case "due":
      return { text: "Due", tone: "warning" };
    case "given":
      return { text: "Given", tone: "success" };
    case "held":
      return { text: "Held", tone: "neutral" };
    case "refused":
      return { text: "Refused", tone: "neutral" };
    default:
      return { text: "Not available", tone: "neutral" };
  }
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
 * The round's headline: what is outstanding across the patients LOADED SO FAR.
 *
 * ── `complete` IS WHAT KEEPS IT HONEST, AND IT IS NOT A DETAIL ──────────────
 * The server pages the round in BED order and says so explicitly: ordering by urgency across the
 * whole ward would mean deriving every slot for every patient before the first page could be cut.
 * So the urgency order this app applies is an order over what is IN THE BROWSER, and a summary
 * taken from page one of three would understate the ward's work. A nurse reading "2 doses due" and
 * stopping is the failure this flag exists to prevent.
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

/**
 * Said out loud when more pages remain, because the sort order is a local one.
 *
 * The alternative — silently presenting a partially-loaded, locally-sorted list as "the round" —
 * is the dishonest version of the same screen.
 */
export function partialOrderNotice(summary: RoundSummary): string | undefined {
  if (summary.complete) return undefined;
  return "Sorted by urgency across the patients loaded so far. Load the rest of the ward to order the whole round.";
}

/**
 * The wards worth offering as a filter, taken from the round itself.
 *
 * ── WHY NOT THE WARD CATALOGUE ──────────────────────────────────────────────
 * A ward is FREE TEXT on this product's admission form (`bed.ward` is a typed string, and the
 * round endpoint matches it exactly). The catalogue at `/wards` is a different list that a site may
 * or may not keep in step, so offering catalogue names would produce filters that silently match
 * nothing. These are the wards patients are actually in, which is the only list that can filter
 * correctly — at the cost of only showing wards on pages already loaded, which is why the control
 * also accepts a typed value.
 */
export function wardOptions(rows: readonly MedicationRoundRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (row.ward) seen.add(row.ward);
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
