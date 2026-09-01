/**
 * Consultation note service (Module D3 / EMR depth).
 *
 * It hangs the note on a REAL, in-scope encounter, and — the one piece of integration — keeps the
 * printed OPD slip in step by deriving the encounter's `diagnosis`/`advice` lines from the
 * structured note whenever it is saved. The derivation is the note's own summary, not a second
 * thing the doctor has to type.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import {
  addDaysToKey,
  dayKeyInZone,
  daysBetweenKeys,
  dayRangeInZone,
} from "../../core/time/day.js";
import { getEncounter, recordVisitSummary, arrivalsForPatientsSince } from "../encounters/index.js";
import { branchZone } from "../branches/index.js";
import { upcomingForPatients } from "../appointments/index.js";
import { namesByIds } from "../patients/index.js";
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

/**
 * The DAY "come back in N days" lands on, at the site that said it.
 *
 * ── THE ANCHOR IS THE VISIT, NOT THE KEYSTROKE ──────────────────────────────
 * Counted from the encounter's `arrivedAt` — when the patient was actually seen — and NOT from
 * the note's `updatedAt`. `updatedAt` moves on every save, so a doctor who reopens the note on
 * day three to add a plan would push a seven-day review out to day ten, and again on the next
 * edit. The instruction the patient was given does not change because the paperwork was tidied,
 * so neither does the date. `arrivedAt` never moves, which makes recomputing on every save
 * produce the identical answer rather than requiring a "only set this once" special case.
 *
 * ── THE CLOCK IS THE SITE'S ────────────────────────────────────────────────
 * Which calendar day an arrival instant belongs to is a question only the branch's zone can
 * answer. On the shipped image the process runs in UTC, so reading the day off the server clock
 * would date a 23:00 IST visit to the previous day and every follow-up from that clinic would be
 * a day early — the defect item C fixed for appointment slots, in a new place.
 *
 * The walk from that day to the due day is then calendar arithmetic on the KEY (`addDaysToKey`),
 * because seven days is seven calendar days and not 604,800,000 milliseconds.
 */
async function dueDayFor(arrivedAt: Date, days: number, branchId?: string): Promise<string> {
  const zone = await branchZone(branchId);
  return addDaysToKey(dayKeyInZone(arrivedAt, zone), days);
}

export async function saveConsultation(
  encounterId: string,
  input: repo.UpsertNoteInput,
): Promise<repo.ConsultationNote> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });

  /**
   * Resolved here rather than in the repository because this is the only layer that holds the
   * encounter. The repository writes the pair or clears the pair; it never decides the date.
   */
  const followUpOn =
    input.followUpDays !== undefined && input.followUpDays > 0
      ? await dueDayFor(encounter.arrivedAt, input.followUpDays, encounter.branchId)
      : undefined;

  const note = await repo.upsert(encounterId, encounter.patientId, encounter.doctorId, {
    ...input,
    ...(followUpOn ? { followUpOn } : {}),
  });

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
