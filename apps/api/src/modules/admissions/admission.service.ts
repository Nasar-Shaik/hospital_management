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
import { getEncounter, dischargePatient as closeTheStay } from "../encounters/index.js";
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
  if (existing) {
    throw new AppError("HMS-STATE-001", 422, "This admission already has a discharge summary", {
      encounterId: encounter.id,
      hint: "one admission, one summary — a correction is a new note on the next encounter",
    });
  }

  const summary = await repo.create({
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

  // Now the stay ends: the encounter closes and `patient.discharged` fires, which is what
  // posts every bed-day not yet billed.
  await closeTheStay(encounter.id, "discharged");

  return { summary, encounterId: encounter.id };
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
