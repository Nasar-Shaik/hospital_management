/**
 * Problem list service — the rules around adding, promoting and resolving a problem.
 *
 * ── THE ONE RULE WORTH READING TWICE: PROMOTION IS A CLINICIAN'S ACT ────────
 * A problem is promoted from a CONSULTATION DIAGNOSIS and from nowhere else. Not automatically
 * (a diagnosis is a statement about a visit; whether it belongs on the longitudinal list is a
 * judgement, and a machine that made it would fill every chart with resolved influenza), and
 * NOT from the MRD coding panel — a coder correcting an encounter's classification after
 * discharge must never create or alter a clinical statement about the patient. `mrd` is a
 * statutory record of a visit; this is what a doctor believes about a person. The dependency
 * graph says so too: this module reads `consultations` and the ICD master, and `mrd` has no
 * route into it.
 *
 * Depends on `patients` (a problem must belong to someone), `consultations` (the source of a
 * promotion, which also proves the visit is real and in scope) and `mrd` (the code master).
 * Nothing reads back, so the graph stays acyclic.
 */
import { AppError } from "../../core/errors/appError.js";
import { getPatient } from "../patients/index.js";
import { getConsultation } from "../consultations/index.js";
import { findActiveIcdByCode } from "../mrd/index.js";
import * as repo from "./problem.repository.js";

export type { Problem } from "./problem.repository.js";

export interface AddProblemInput {
  patientId: string;
  title: string;
  code?: string;
  onsetDate?: Date;
  sourceEncounterId?: string;
  branchId?: string;
}

/**
 * A code is stored ONLY if this hospital's ICD master recognises it.
 *
 * This is the whole difference between the problem list and `consultation.diagnoses[].code`,
 * which is free text nobody checks. A problem coded `J189` (no dot) or `PNEUMONIA` looks coded
 * on screen and matches nothing in a register — a wrong answer wearing the clothes of a right
 * one. Refused at the door instead, naming the code.
 */
async function validatedCode(code: string): Promise<string> {
  const found = await findActiveIcdByCode(code);
  if (!found) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      code: [`"${code}" is not an active code in this hospital's ICD master`],
    });
  }
  return found.code;
}

async function insert(input: AddProblemInput): Promise<repo.Problem> {
  try {
    return await repo.create({
      patientId: input.patientId,
      title: input.title,
      ...(input.code ? { code: input.code } : {}),
      ...(input.onsetDate ? { onsetDate: input.onsetDate } : {}),
      ...(input.sourceEncounterId ? { sourceEncounterId: input.sourceEncounterId } : {}),
      ...(input.branchId ? { branchId: input.branchId } : {}),
    });
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-PROB-001", 409, "That problem is already on the active list", {
        patientId: input.patientId,
        code: input.code,
        hint: "resolve the existing entry first if it was recorded in error",
      });
    }
    throw err;
  }
}

/**
 * Adds a problem directly — the doctor knows the patient has it and is not writing a note about
 * it right now (a hypertension noted at a follow-up, a condition the patient reports on arrival).
 *
 * The patient must exist: `getPatient` throws HMS-PAT-001 if the id names nobody, which is more
 * specific than a generic 404 and is almost always an id typo that would otherwise hang a
 * diagnosis on nothing.
 */
export async function addProblem(input: {
  patientId: string;
  title: string;
  code?: string;
  onsetDate?: Date;
}): Promise<repo.Problem> {
  const patient = await getPatient(input.patientId);
  const code = input.code ? await validatedCode(input.code) : undefined;

  return insert({
    patientId: input.patientId,
    title: input.title,
    ...(code ? { code } : {}),
    ...(input.onsetDate ? { onsetDate: input.onsetDate } : {}),
    // Provenance fallback when no branch is selected — see `repo.create`.
    ...(patient.branchId ? { branchId: patient.branchId } : {}),
  });
}

export interface PromoteInput {
  /** Which entry in the visit's `diagnoses[]` the clinician chose. */
  diagnosisIndex: number;
  /** An ICD code the clinician picked at promotion time. Overrides whatever the note holds. */
  code?: string;
  onsetDate?: Date;
}

/**
 * Promotes one of a visit's diagnoses onto the patient's problem list.
 *
 * ── WHY THE NOTE'S OWN `code` IS NOT COPIED BLINDLY ─────────────────────────
 * `consultation.diagnoses[].code` is free text — the model says so: "the doctor types it if they
 * know it". Copying it into a field that is supposed to be a key into the ICD master would put
 * unverifiable strings in the one place that promised verified ones. So it is copied only when
 * the master recognises it, and otherwise the problem is simply UNCODED — which is honest, and
 * still better than the free-text line it came from. A code supplied in the request is validated
 * the same way and wins.
 *
 * `getConsultation` does the access work: it resolves the encounter through `scopeFilter()` and
 * throws HMS-GEN-404 when the visit is not this caller's to see — another branch's, or another
 * tenant's. There is no second check here, deliberately; one door, one rule.
 */
export async function promoteDiagnosis(
  encounterId: string,
  input: PromoteInput,
): Promise<repo.Problem> {
  const note = await getConsultation(encounterId);
  if (!note) {
    throw new AppError("HMS-VAL-001", 422, "This visit has no consultation note to promote from", {
      encounterId,
      hint: "write and save the consultation note first",
    });
  }

  const diagnosis = note.diagnoses[input.diagnosisIndex];
  if (!diagnosis) {
    throw new AppError("HMS-VAL-001", 422, "That diagnosis is not on this visit's note", {
      encounterId,
      diagnosisIndex: input.diagnosisIndex,
      diagnoses: note.diagnoses.length,
    });
  }

  const code = input.code
    ? await validatedCode(input.code)
    : diagnosis.code
      ? // The note's own code, kept ONLY if the master knows it. `undefined` otherwise — an
        // uncoded problem, not a fabricated code.
        (await findActiveIcdByCode(diagnosis.code))?.code
      : undefined;

  return insert({
    patientId: note.patientId,
    title: diagnosis.text,
    sourceEncounterId: encounterId,
    ...(code ? { code } : {}),
    ...(input.onsetDate ? { onsetDate: input.onsetDate } : {}),
    ...(note.branchId ? { branchId: note.branchId } : {}),
  });
}

/** The whole list — active first, then resolved. */
export async function listProblems(patientId: string): Promise<repo.Problem[]> {
  return repo.listForPatient(patientId);
}

/** Just what still applies — the chart banner and the consultation screen. */
export async function activeProblems(patientId: string): Promise<repo.Problem[]> {
  return repo.listActiveForPatient(patientId);
}

/** Closes a problem. Refused if it is already resolved — that is not an error to hide. */
export async function resolveProblem(id: string, reason?: string): Promise<repo.Problem> {
  const existing = await repo.findById(id);
  if (!existing) {
    throw new AppError("HMS-GEN-404", 404, "Problem not found", { id });
  }

  const resolved = await repo.resolve(id, reason);
  if (!resolved) {
    // The CAS matched on `status: active`; a miss means it was resolved between our read and our
    // write. Name the state rather than just failing.
    throw new AppError("HMS-STATE-001", 422, "That problem has already been resolved", {
      id,
      status: existing.status,
    });
  }
  return resolved;
}
