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
import {
  marSlotTaken,
  type DoseSlot,
  type MarStatus,
  type MedicationAdministration,
} from "@medicore/api-client";
import { ApiClientError } from "@medicore/api-client";

/** The three outcomes S5A offers. A subset of `MarStatus` — see `OUTCOMES` for why. */
export type AdministerOutcome = Extract<MarStatus, "given" | "held" | "refused">;

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
 * The outcomes this screen offers, in the order they appear.
 *
 * ── `not_available` IS IN THE DOMAIN AND IS DELIBERATELY NOT HERE ───────────
 * `MAR_STATUSES` also carries `not_available` ("the drug was not on the ward"). It is a real
 * outcome and the backend has always accepted it; S5A's scope is the three decisions a nurse makes
 * AT THE BEDSIDE with the patient in front of them. Widening the scope is not this slice's call —
 * it is reported instead, because the cost of leaving it out is real: a nurse who cannot record
 * "not available" will record "held" with a reason, which quietly moves a stock failure into the
 * clinical-decision column.
 *
 * ── ONLY `held` REQUIRES A REASON, AND THAT IS THE SERVER'S RULE ────────────
 * `recordAdministration` refuses a held dose with no reason ("say why the dose was held") and does
 * not refuse a refused one. Mirrored here rather than decided here: a reason is offered on all
 * three, because "patient nauseated" against a refusal is worth having, but only the one the
 * server insists on is enforced before the button enables.
 */
export const OUTCOMES: readonly OutcomeOption[] = [
  { status: "given", label: "Give medication", recordAs: "Given", reasonRequired: false },
  {
    status: "held",
    label: "Hold dose",
    recordAs: "Held",
    reasonRequired: true,
    reasonPrompt: "Why is it being held? e.g. systolic 84, patient nil by mouth",
  },
  {
    status: "refused",
    label: "Patient refused",
    recordAs: "Refused",
    reasonRequired: false,
    reasonPrompt: "Anything the next nurse should know. Optional.",
  },
];

export const outcomeOption = (status: AdministerOutcome): OutcomeOption =>
  OUTCOMES.find((o) => o.status === status) as OutcomeOption;

/**
 * Is this slot still open to an answer?
 *
 * ── `due` AND `overdue` ARE THE ONLY OPEN STATES ────────────────────────────
 * Both are DERIVED BY THE SERVER from the ward's clock; the other four are recorded facts. An
 * overdue dose is still very much giveable — that is the whole point of showing it — so lateness
 * gates nothing. Anything else means the slot is answered and the actions must be gone, not
 * disabled: a greyed-out "Give" invites a nurse to work out how to un-grey it.
 *
 * This is advisory only. The DATABASE refuses the second write whatever this returns, which is
 * what makes it safe for two nurses to have the same screen open at the same moment.
 */
export function isOpen(slot: Pick<DoseSlot, "state">): boolean {
  return slot.state === "due" || slot.state === "overdue";
}

/** The answer already on a slot, for rendering instead of the actions. */
export function answeredAs(slot: DoseSlot): MarStatus | undefined {
  return isOpen(slot) ? undefined : (slot.state as MarStatus);
}

/**
 * Finding one slot in the schedule, by the identity S1 established.
 *
 * ── THREE PARTS, AND ALL THREE ARE LOAD-BEARING ─────────────────────────────
 * `prescriptionId` + `lineIndex` + `scheduledFor`. Not `drugCode`: one prescription may legitimately
 * carry paracetamol QID on the round AND paracetamol SOS for breakthrough fever, and matching on
 * the code takes whichever comes first — charting the regular line when the nurse meant the PRN
 * one, or the 08:00 slot when they meant 14:00. `mar.model.ts` explains why the line POSITION is
 * safe as an identity: a signed prescription's lines are immutable, so the position cannot move.
 *
 * Not the drug NAME either, ever. Display text is for humans.
 */
export interface SlotRef {
  prescriptionId: string;
  lineIndex: number;
  scheduledFor: string;
}

export function sameSlot(slot: DoseSlot, ref: SlotRef): boolean {
  return (
    slot.prescriptionId === ref.prescriptionId &&
    slot.lineIndex === ref.lineIndex &&
    slot.scheduledFor === ref.scheduledFor
  );
}

export function findSlot(
  slots: readonly DoseSlot[] | undefined,
  ref: SlotRef,
): DoseSlot | undefined {
  return slots?.find((slot) => sameSlot(slot, ref));
}

/* ── the write ─────────────────────────────────────────────────────────────── */

export type AdministerResult =
  /** The server wrote it. This is the only state that may be shown as done. */
  | { outcome: "recorded"; entry: MedicationAdministration }
  /**
   * The slot was already answered — by us on a lost attempt, or by another nurse. NOT a failure:
   * it is the answer, and `existing` (when the server could name it) says who and when.
   */
  | { outcome: "alreadyAnswered"; existing?: MedicationAdministration; drugName: string }
  /** Nothing was written and re-sending will not help. Show it; do not offer a retry. */
  | { outcome: "failed"; error: unknown }
  /**
   * We could not find out. The slot still reads open, so the dose is PROBABLY not charted — but
   * "probably" is why this is its own state and not `failed`.
   */
  | { outcome: "unknown"; error: unknown };

export interface AdministerDeps {
  /** `POST …/medication-administrations`, with the intent key. Called AT MOST ONCE per attempt. */
  record: () => Promise<MedicationAdministration>;
  /** `GET …/medication-schedule` — the slot oracle, read only when the attempt was ambiguous. */
  reloadSchedule: () => Promise<DoseSlot[]>;
  /** Which slot this attempt answers. */
  ref: SlotRef;
}

/**
 * Errors decided BEFORE anything could be written.
 *
 * `HMS-REQ-002` — this key was used for a different body — belongs here and is worth the note: the
 * request was refused outright, so nothing was charted under it, and reconciling would find
 * whatever the EARLIER request wrote and risk reporting it as this one.
 *
 * `HMS-REQ-004` (the same key is still in flight) is deliberately NOT here. That first attempt may
 * be committing right now, so the only honest answer comes from the slot.
 */
function isDefinitelyNotWritten(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-STATE-001" ||
    error.code === "HMS-REQ-002"
  );
}

/**
 * One attempt at answering a dose.
 *
 *     record
 *       ├─ 201                  → recorded
 *       ├─ 409 HMS-MAR-001      → alreadyAnswered   ← the slot's own answer, with `existing`
 *       ├─ 401/403/400/404/422  → failed (decided before the write)
 *       └─ anything else        → ask the slot      ← every timeout, every 5xx, HMS-REQ-004
 *
 *     ask the slot = re-read the schedule and look at THIS slot
 *       ├─ answered             → alreadyAnswered
 *       ├─ still due / overdue  → unknown           ← almost certainly not written, but not proven
 *       └─ reload failed / gone → unknown
 *
 * ── WHY THE AMBIGUOUS CASE IS `unknown` AND NOT `notSaved` ──────────────────
 * Vitals could say "not saved" and invite another press, because the cost of being wrong was one
 * duplicate row. Here the cost of being wrong is a second dose, so the app declines to say
 * anything it has not established. A nurse told "we could not confirm this" checks the chart; a
 * nurse told "not saved" gives it again. The wording is the safety feature.
 */
export async function attemptAdministration(deps: AdministerDeps): Promise<AdministerResult> {
  try {
    return { outcome: "recorded", entry: await deps.record() };
  } catch (error) {
    const taken = marSlotTaken(error);
    if (taken) {
      return {
        outcome: "alreadyAnswered",
        drugName: taken.drugName,
        ...(taken.existing ? { existing: taken.existing } : {}),
      };
    }
    if (isDefinitelyNotWritten(error)) return { outcome: "failed", error };
    return reconcileSlot(deps, error);
  }
}

/**
 * "Is this dose charted?" — asked of the slot, which is the only thing that can answer it.
 *
 * Exported so a screen can ask on its own: a nurse who backgrounds the app mid-save and returns
 * must get the answer from this path rather than from a hopeful refetch nobody classifies.
 */
export async function reconcileSlot(
  deps: AdministerDeps,
  error: unknown,
): Promise<AdministerResult> {
  let slots: DoseSlot[];
  try {
    slots = await deps.reloadSchedule();
  } catch {
    // The original failure is what the nurse is told about. The reload failing on top of it is our
    // problem, and reporting it would replace a useful message with a confusing one.
    return { outcome: "unknown", error };
  }

  const slot = findSlot(slots, deps.ref);
  // The slot has vanished from today's schedule — the order was stopped, or the day rolled over in
  // the ward's zone while the screen sat open. Nothing can be concluded about the dose from that.
  if (!slot) return { outcome: "unknown", error };

  if (isOpen(slot)) return { outcome: "unknown", error };

  return {
    outcome: "alreadyAnswered",
    drugName: slot.drugName,
    ...(slot.administrationId
      ? {
          existing: {
            id: slot.administrationId,
            status: slot.state as MarStatus,
            drugName: slot.drugName,
            ...(slot.administeredAt ? { administeredAt: slot.administeredAt } : {}),
            ...(slot.administeredBy ? { administeredBy: slot.administeredBy } : {}),
            ...(slot.reason ? { reason: slot.reason } : {}),
          } as MedicationAdministration,
        }
      : {}),
  };
}

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
  if (!slot || !isOpen(slot) || inFlight) return false;
  if (outcomeOption(outcome).reasonRequired && reason.trim() === "") return false;
  return true;
}
