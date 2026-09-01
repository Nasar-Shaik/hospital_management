/**
 * Answering one scheduled dose (M3-S5A) — the most consequential write in this app.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER WRITE ────────────────────────
 * A duplicate ward note is embarrassing. A duplicate vitals reading is confusing. A duplicate dose
 * is a second drug in a patient. So this slice consumes a safety spine rather than inventing one,
 * and the division of labour is absolute:
 *
 *   the DATABASE decides whether a slot is free   — unique index, migration 0049
 *   the SERVER decides what is due and when       — the schedule endpoint, in the ward's zone
 *   this FILE decides what to show and what to send
 *
 * Nothing here checks for duplicates. A client-side "has this been given?" test cannot be
 * authoritative — between the check and the request another nurse's dose fits — and writing one
 * would create a second, weaker answer to a question the index already answers exactly.
 *
 * ── THE ORACLE IS THE SLOT, NOT THE ROW ─────────────────────────────────────
 * Vitals had to reconcile by set-difference on ids, because "did my reading land?" has no better
 * question behind it. MAR does: **is this exact slot answered?** — one question, one server
 * answer, no inference from timestamps or drug text and certainly not from the device clock. That
 * is a strictly stronger oracle and it is why this file looks different from `vitalsWrite.ts`.
 */
import { type DoseSlot, type MarStatus, type MedicationAdministration } from "@medicore/api-client";

/**
 * ── THE SPINE ITSELF NOW LIVES IN `@medicore/api-client` ────────────────────
 * Slot identity and the attempt classifier were written here first, for S5A. They moved to the
 * client package when the WEB ward screen needed exactly the same safety envelope (W3): which HTTP
 * failures mean "nothing was written" is the API's promise, not this app's opinion, and a phone and
 * a browser charting the same dose must reach the same verdict from the same response.
 *
 * Re-exported under the names this app has always used, so every call site and every S5A test
 * reads unchanged — and those tests, still passing against the shared implementation, are what
 * proves the move changed no behaviour.
 *
 * What stays here is what is genuinely THIS app's: the outcomes offered at the bedside, their
 * wording, the review lines, and the confirm gate.
 */
import { isSlotOpen } from "@medicore/api-client";

export {
  attemptAdministration,
  reconcileSlot,
  findSlot,
  sameSlot,
  isSlotOpen as isOpen,
  slotAnsweredAs as answeredAs,
  type AdministerDeps,
  type AdministerResult,
  type SlotRef,
} from "@medicore/api-client";

/**
 * Every outcome the domain has — this screen now offers all of them.
 *
 * This was `Extract<MarStatus, "given" | "held" | "refused">`, and the alias is now the domain type
 * itself: there is no outcome the record can hold that a nurse cannot record. See `OUTCOMES`.
 */
export type AdministerOutcome = MarStatus;

export interface OutcomeOption {
  status: AdministerOutcome;
  /** The button, in the words a nurse would use out loud. */
  label: string;
  /** What the record will say, for the review line. */
  recordAs: string;
  /** True when the server refuses the write without a reason — see `mar.service.ts`. */
  reasonRequired: boolean;
  /** Prompt for the reason field. Absent when a reason adds nothing. */
  reasonPrompt?: string;
}

/**
 * ── `not_available` IS OFFERED NOW (S5A DEFERRED IT; THE DEFERRAL HAD A COST) ─
 * `MAR_STATUSES` has always carried `not_available` ("the drug was not on the ward to give"), the
 * backend has always accepted and persisted it, and both clients already DISPLAY it. Neither
 * offered it, so nobody could ever record it — and S5A's own note said what that costs: a nurse who
 * cannot record "not available" records HELD with a reason, filing a supply failure in the
 * clinical-decision column. The next nurse reads `held` as "somebody decided to withhold this",
 * which is a different fact about the patient.
 *
 * The MAR has exactly one writer (`mar:administer`, the nurse) and a stock-out is only observable
 * at the bedside, so there was no other surface this could have arrived through.
 *
 * ── ONLY `held` REQUIRES A REASON, AND THAT IS THE SERVER'S RULE ────────────
 * `recordAdministration` refuses a held dose with no reason ("say why the dose was held") and
 * refuses nothing else without one. Mirrored here rather than decided here: a reason is OFFERED on
 * all four, because "patient nauseated" against a refusal is worth having, but only the one the
 * server insists on is enforced before the button enables. `not_available` is deliberately not made
 * to require one — a client-side rule the server does not have would block a true fact.
 *
 * Nothing about `given`, `held` or `refused` changes.
 */
const BY_STATUS: Record<MarStatus, OutcomeOption> = {
  given: { status: "given", label: "Give medication", recordAs: "Given", reasonRequired: false },
  held: {
    status: "held",
    label: "Hold dose",
    recordAs: "Held",
    reasonRequired: true,
    reasonPrompt: "Why is it being held? e.g. systolic 84, patient nil by mouth",
  },
  refused: {
    status: "refused",
    label: "Patient refused",
    recordAs: "Refused",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know. Optional.",
  },
  not_available: {
    status: "not_available",
    label: "Not on the ward",
    // The same words `marStatusLabel` already prints for this status on the chart and the round.
    recordAs: "Not available",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know — e.g. none in the ward stock. Optional.",
  },
};

/**
 * The outcomes this screen offers, in the order they appear.
 *
 * Built from `BY_STATUS`, a `Record<MarStatus, …>`: a fifth `MAR_STATUS` server-side becomes a
 * COMPILE ERROR here rather than another status the clients quietly never offer — which is exactly
 * how `not_available` went unofferable for two milestones.
 *
 * `not_available` sits last: it is the only one that is not a decision about the patient.
 */
export const OUTCOMES: readonly OutcomeOption[] = [
  BY_STATUS.given,
  BY_STATUS.held,
  BY_STATUS.refused,
  BY_STATUS.not_available,
];

/** Total, so no cast. The old `find(...) as OutcomeOption` would have returned `undefined`. */
export const outcomeOption = (status: AdministerOutcome): OutcomeOption => BY_STATUS[status];

/* ── words ─────────────────────────────────────────────────────────────────── */

/**
 * Who answered the slot, in words a nurse can act on.
 *
 * ── THE APP CANNOT RESOLVE A STAFF NAME, AND SAYS SO RATHER THAN GUESSING ───
 * `administeredBy` is an opaque user id and there is no endpoint a nurse may call to turn it into
 * a name — the user directory needs `user:manage`, which the NURSE role does not hold and should
 * not. Printing the raw id would be noise. So this says the one distinction that changes what the
 * nurse does next: was it me (my own lost attempt) or somebody else (go and ask them).
 */
export function actorLabel(administeredBy: string | undefined, meId: string | undefined): string {
  if (administeredBy === undefined) return "by another member of staff";
  if (meId !== undefined && administeredBy === meId) return "by you";
  return "by another member of staff";
}

/** Whether the existing answer is this nurse's own — a lost response rather than a colleague. */
export function isOwnAnswer(
  existing: Pick<MedicationAdministration, "administeredBy"> | undefined,
  meId: string | undefined,
): boolean {
  return existing?.administeredBy !== undefined && existing.administeredBy === meId;
}

export interface ReviewLine {
  label: string;
  value: string;
  /** True for the lines a nurse checks against the patient in front of them. */
  identity?: boolean;
}

/**
 * The facts on the confirmation, in the order they should be checked.
 *
 * ── PATIENT FIRST, DRUG SECOND, AND NEITHER IS OPTIONAL ─────────────────────
 * This is the app's rendering of the five rights. It leads with WHO because that is the check that
 * catches the catastrophic error — the right drug given to the wrong patient — and it names them
 * by name AND identifier, never by bed. A bed is where somebody was an hour ago.
 *
 * The scheduled time is passed in ALREADY FORMATTED, in the branch's zone: this module holds no
 * clock and no formatter, and a test scans it for both.
 */
export function reviewLines(input: {
  patientName?: string;
  uhid?: string;
  slot: DoseSlot;
  scheduledLabel: string;
  outcome: AdministerOutcome;
}): ReviewLine[] {
  const { patientName, uhid, slot, scheduledLabel, outcome } = input;
  return [
    { label: "Patient", value: patientName ?? "Not loaded", identity: true },
    { label: "UHID", value: uhid ?? "Not loaded", identity: true },
    { label: "Medication", value: slot.drugName, identity: true },
    { label: "Dose", value: slot.dose, identity: true },
    { label: "Route", value: slot.route, identity: true },
    { label: "Scheduled", value: scheduledLabel, identity: true },
    { label: "Recording", value: outcomeOption(outcome).recordAs },
  ];
}

/**
 * May the confirm button be pressed?
 *
 * UI gating only, and the comment is here because it is the sentence most likely to be misread:
 * this is NOT what stops a double dose. The unique index is. This stops a nurse being invited to
 * submit something the server is certain to refuse, which is a different and much smaller job.
 */
export function canConfirm(input: {
  slot: DoseSlot | undefined;
  outcome: AdministerOutcome;
  reason: string;
  inFlight: boolean;
}): boolean {
  const { slot, outcome, reason, inFlight } = input;
  if (!slot || !isSlotOpen(slot) || inFlight) return false;
  if (outcomeOption(outcome).reasonRequired && reason.trim() === "") return false;
  return true;
}
