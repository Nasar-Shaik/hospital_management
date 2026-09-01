/**
 * Admissions — the ward's half of an inpatient stay.
 *
 * ── WHAT THIS MODULE IS, AND IS NOT ─────────────────────────────────────────
 * It owns `wardNotes` and orchestrates the discharge. It does NOT own the admission:
 * **the IP encounter IS the admission** (ADR-0013 §1), so admitting, discharging and the
 * bed all live on `encounters`, which owns that collection. This module depends on
 * `encounters`; nothing depends on this. Same shape as `staff` and `pharmacy` — the use
 * case lives one level up, and the graph stays acyclic.
 *
 * If this module owned an `admissions` collection it would be a second object meaning
 * "this patient is here", and keeping it in step with the encounter would be a permanent
 * tax paid in bugs. ADR-0013 was written to kill exactly that shape.
 */
import { AppError } from "../../core/errors/appError.js";
import {
  getEncounter,
  dischargePatient as closeTheStay,
  transferBed as moveBed,
  type DischargeDisposition,
} from "../encounters/index.js";
import * as repo from "./wardNote.repository.js";

export type { WardNote } from "./wardNote.repository.js";

export interface AddNoteInput {
  encounterId: string;
  text: string;
}

export interface DischargeInput {
  encounterId: string;
  /** What happened, in the doctor's words. The body of the summary. */
  text: string;
  diagnosis?: string;
  advice?: string;
  followUpOn?: Date;
}

/**
 * Today's entry on the ward round.
 *
 * Requires an OPEN inpatient encounter: a progress note on a discharged patient is either
 * a mistake or a backdated entry, and neither should be silently accepted. If something
 * genuinely needs recording after the fact, it belongs in the discharge summary or in the
 * patient's next encounter — both of which are honest about when they were written.
 */
export async function addNote(input: AddNoteInput): Promise<repo.WardNote> {
  const encounter = await requireOpenAdmission(input.encounterId, "note");

  return repo.create({
    encounterId: encounter.id,
    // From the ENCOUNTER, never the body — the same rule as orders and prescriptions.
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    type: "progress",
    text: input.text,
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });
}

/**
 * The nurse's bedside entry (M3-S2).
 *
 * ── WHY THIS IS A SEPARATE FUNCTION AND A SEPARATE ROUTE ────────────────────
 * A nurse could not write ANY note before this. `POST /encounters/:id/notes` requires
 * `emr:write`, which NURSE does not hold — and granting it would also hand them
 * `discharge_summary` and `outcome_note`, which are the doctor's records and, in the case of an
 * outcome note, the statutory account of a death.
 *
 * `authorize()` takes exactly one permission and the RBAC matrix reads those tags back off the
 * shipped app, so a second permission on the existing route is not expressible. A separate route
 * with `nursing:manage` is: it removes the question rather than answering it, and it finally gives
 * that permission something to gate — it was granted to NURSE and reached nothing.
 *
 * The note lands in the SAME collection with `type: "nursing"`, so the chart stays one record and
 * `GET /encounters/:id/notes` shows the nursing entries beside the medical ones without any
 * client change. The type is set HERE, never taken from the body, and the DTO has no `type` field
 * at all — so this endpoint cannot be talked into writing a discharge summary.
 */
export async function addNursingNote(input: AddNoteInput): Promise<repo.WardNote> {
  // Same `note` intent as its medical sibling: the rule is identical (an inpatient stay must be
  // open) and the hint it selects is accurate for both. The intent picks a sentence, never a rule.
  const encounter = await requireOpenAdmission(input.encounterId, "note");

  return repo.create({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    type: "nursing",
    text: input.text,
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });
}

export interface TransferBedInput {
  encounterId: string;
  bedId?: string;
  ward?: string;
  bedCode?: string;
  reason?: string;
}

/**
 * Moves an admitted patient to another bed and records WHY on the ward round.
 *
 * The move itself is the encounter's job (`encounters.transferBed` owns the bed and the occupancy
 * invariant). Admissions adds what the ward round needs afterwards: a progress note that says the
 * patient was moved, from where to where, and the reason — so a doctor reading the chart tomorrow
 * sees the transfer in the same feed as every other event of the stay, not only in the audit trail.
 * The note is best-effort AFTER the move: if it failed, the patient has still been moved (the
 * important, occupancy-guarded act), and a missing narrative line is recoverable; a bed move that
 * rolled back because a note failed would not be.
 */
export async function transferBed(
  input: TransferBedInput,
): Promise<{ from: { ward: string; bedCode: string }; to: { ward: string; bedCode: string } }> {
  const result = await moveBed(input.encounterId, {
    ...(input.bedId ? { bedId: input.bedId } : {}),
    ...(input.ward ? { ward: input.ward } : {}),
    ...(input.bedCode ? { bedCode: input.bedCode } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });

  const { encounter, from, to } = result;
  const line =
    `Bed transfer: ${from.ward} / ${from.bedCode} → ${to.ward} / ${to.bedCode}` +
    (input.reason ? `. Reason: ${input.reason}` : "");

  await repo.create({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    type: "progress",
    text: line,
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });

  return { from, to };
}

/**
 * "This admission already has a discharge summary" — the ONE answer, whichever guard found out.
 *
 * The pre-read and the unique index detect the same fact at different moments, so they must not
 * produce different answers: a client that has to distinguish them is a client that will get one
 * of them wrong.
 */
function alreadySummarised(encounterId: string): AppError {
  return new AppError("HMS-STATE-001", 422, "This admission already has a discharge summary", {
    encounterId,
    hint: "one admission, one summary — a correction is a new note on the next encounter",
  });
}

/**
 * The patient goes home, with the summary in their hand.
 *
 * ── THE SUMMARY IS WRITTEN BEFORE THE STAY IS CLOSED, AND THAT ORDER MATTERS ─
 * If the encounter closed first, `requireOpenAdmission` inside the note write would refuse
 * the summary — the patient would be discharged with no document, and there would be no
 * way to add one afterwards without reopening a closed stay. Writing the summary first
 * means the worst case is a summary on a patient still marked as in a bed, which the ward
 * can see and fix by discharging them again. The reverse failure is silent and permanent.
 *
 * The summary is NOT optional and the API gives no way to skip it. A discharge with no
 * summary is the single most common complaint about hospital software from the doctor who
 * sees the patient next: they get a person who was in hospital for a week and no statement
 * of what was found or done. For a patient who goes back to a village clinic, this
 * document is the entire medical record of the stay.
 */
export async function dischargeWithSummary(
  input: DischargeInput,
): Promise<{ summary: repo.WardNote; encounterId: string }> {
  const encounter = await requireOpenAdmission(input.encounterId, "discharge");

  const existing = await repo.findDischargeSummary(encounter.id);
  if (existing) throw alreadySummarised(encounter.id);

  let summary: repo.WardNote;
  try {
    summary = await repo.create({
      encounterId: encounter.id,
      patientId: encounter.patientId,
      episodeId: encounter.episodeId,
      type: "discharge_summary",
      text: input.text,
      ...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
      ...(input.advice ? { advice: input.advice } : {}),
      ...(input.followUpOn ? { followUpOn: input.followUpOn } : {}),
      ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
    });
  } catch (err) {
    /**
     * ── THE READ ABOVE LOSES THE RACE; THIS IS WHERE IT IS ACTUALLY DECIDED ───
     * `findDischargeSummary` catches the ordinary sequential retry, and that is the case it
     * exists for. It cannot catch two submissions in flight at once — both read "no summary" and
     * both write — so `one_discharge_summary_per_admission` (migration 0016) is the real arbiter,
     * exactly as the unique index is in the MAR, dispensing and ordering paths.
     *
     * Without this branch that arbitration surfaced as a raw duplicate-key error, which the error
     * handler renders as **500 "Something went wrong"**. Two doctors ending the same stay at once
     * therefore produced one discharge and one server error, on a perfectly healthy hospital —
     * and a 500 is the one answer a client cannot interpret: mobile's `attemptDischarge`
     * reconciles it correctly by re-reading, but the web ward screen shows the raw failure to
     * somebody whose patient is, in fact, already discharged.
     *
     * The index winning means precisely what the read above means, so it gets the same answer.
     */
    if (!repo.isDuplicateKey(err)) throw err;
    throw alreadySummarised(encounter.id);
  }

  // Now the stay ends: the encounter closes with disposition `discharged` and
  // `patient.discharged` fires, which is what posts every bed-day not yet billed.
  await closeTheStay(encounter.id, "discharged");

  return { summary, encounterId: encounter.id };
}

/** LAMA, absconded, or a death — the ways a stay ends that are NOT a routine discharge. */
export type TerminalOutcome = Exclude<DischargeDisposition, "discharged">;

export interface OutcomeInput {
  encounterId: string;
  outcome: TerminalOutcome;
  /**
   * The account of what happened — the risks explained before the patient left against
   * advice, when an absence was discovered, or the circumstances of a death. Required:
   * this note is the record, and a non-routine ending with no account of it is the very
   * gap this feature exists to close.
   */
  text: string;
}

/**
 * The stay ends without a routine discharge — the patient left against advice, absconded,
 * or died.
 *
 * ── WHY THIS IS A SEPARATE DOOR FROM `dischargeWithSummary` ──────────────────
 * A routine discharge produces a summary the patient carries home. None of these three do:
 * there is no patient to hand it to, or there should never have been a homegoing document
 * at all. Filing them as an ordinary discharge — which is what happened before this — is a
 * false record, and for a death it is a false statutory record. So they get their own note
 * (`outcome_note`) and their own disposition, and the encounter closes carrying WHICH of
 * the four endings it was, not a uniform "discharged".
 *
 * The note is written BEFORE the stay closes, for the same reason the summary is: if the
 * encounter closed first, `requireOpenAdmission` would refuse the note and the ending would
 * have no account at all. The worst case this way is a note on a stay still marked open,
 * which the ward can see and close again — recoverable, unlike a silent, permanent gap.
 */
export async function recordOutcome(
  input: OutcomeInput,
): Promise<{ note: repo.WardNote; encounterId: string }> {
  const encounter = await requireOpenAdmission(input.encounterId, "discharge");

  const note = await repo.create({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    type: "outcome_note",
    text: input.text,
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });

  // The stay closes carrying its true disposition. `patient.discharged` still fires — the
  // bed was occupied until this moment, so its bed-days bill exactly as a discharge's do.
  await closeTheStay(encounter.id, input.outcome);

  return { note, encounterId: encounter.id };
}

/**
 * ── THE HINT DEPENDS ON WHAT THE CALLER WAS TRYING TO DO ────────────────────
 * This guard is shared by "write a note" and "discharge", and an earlier version gave both
 * of them the note hint: a doctor trying to discharge an outpatient was told "ward notes
 * belong to an inpatient stay", which is true, unhelpful, and about something they were
 * not doing. An error message that answers the wrong question costs more than no message —
 * it sends someone looking in the wrong place.
 *
 * The `intent` is only ever used to say the right sentence. It changes no behaviour, and
 * it must not: the RULE is the same for both, and only the remedy differs.
 */
async function requireOpenAdmission(
  encounterId: string,
  intent: "note" | "discharge",
): Promise<{ id: string; patientId: string; episodeId: string; branchId?: string }> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });
  }
  if (encounter.class !== "IP") {
    throw new AppError("HMS-STATE-001", 422, "This patient is not admitted", {
      encounterId,
      class: encounter.class,
      hint:
        intent === "discharge"
          ? "an outpatient visit is CLOSED, not discharged — POST /encounters/:id/close"
          : "ward notes belong to an inpatient stay — an OP consultation is not one",
    });
  }
  if (encounter.status === "closed") {
    throw new AppError("HMS-STATE-001", 422, "This admission is already over", {
      encounterId,
      hint:
        intent === "discharge"
          ? "this patient has already been discharged"
          : "the patient has gone home — anything further belongs to their next encounter",
    });
  }

  return encounter;
}

export const notesFor = repo.listForEncounter;
export const dischargeSummaryFor = repo.findDischargeSummary;
