/**
 * Consultation note service (Module D3 / EMR depth).
 *
 * It hangs the note on a REAL, in-scope encounter, and — the one piece of integration — keeps the
 * printed OPD slip in step by deriving the encounter's `diagnosis`/`advice` lines from the
 * structured note whenever it is saved. The derivation is the note's own summary, not a second
 * thing the doctor has to type.
 */
import { AppError } from "../../core/errors/appError.js";
import { getEncounter, recordVisitSummary } from "../encounters/index.js";
import * as repo from "./consultation.repository.js";
import type { Diagnosis } from "./consultation.model.js";

export type { ConsultationNote } from "./consultation.repository.js";

export async function getConsultation(
  encounterId: string,
): Promise<repo.ConsultationNote | undefined> {
  // Validate the encounter is real and in the caller's scope before returning (or admitting there
  // is) a note — a note id is an encounter id, and probing one must not leak the other.
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });
  return repo.findByEncounter(encounterId);
}

/** The one-line diagnosis the OPD slip prints — final diagnoses if any, else the working ones. */
function summariseDiagnoses(diagnoses: Diagnosis[]): string {
  const finals = diagnoses.filter((d) => d.type === "final");
  const chosen = finals.length > 0 ? finals : diagnoses;
  return chosen.map((d) => (d.code ? `${d.text} (${d.code})` : d.text)).join("; ");
}

export async function saveConsultation(
  encounterId: string,
  input: repo.UpsertNoteInput,
): Promise<repo.ConsultationNote> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });

  const note = await repo.upsert(encounterId, encounter.patientId, encounter.doctorId, input);

  // Keep the OPD slip truthful: its diagnosis line is the note's final diagnoses, its advice is the
  // plan. Only sync the fields the doctor touched this save, so an untouched slip line is left alone.
  const summary: { diagnosis?: string; advice?: string } = {};
  if (input.diagnoses !== undefined) summary.diagnosis = summariseDiagnoses(note.diagnoses);
  if (input.plan !== undefined) summary.advice = input.plan;
  if (summary.diagnosis !== undefined || summary.advice !== undefined) {
    await recordVisitSummary(encounterId, summary);
  }

  return note;
}
