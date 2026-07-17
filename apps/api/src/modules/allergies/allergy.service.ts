/**
 * Allergy service — the rules around recording, listing and ruling out an allergy.
 *
 * The prescribing CHECK does not live here — it is a pure function in `drugSafety`, called
 * by the prescription service at the moment of signing. This module owns the STORE: what is
 * on the list, who put it there, and who took it off.
 */
import { AppError } from "../../core/errors/appError.js";
import { getPatient } from "../patients/index.js";
import { isAllergen, ALLERGENS, type Allergen } from "../drugSafety/index.js";
import * as repo from "./allergy.repository.js";
import type { AllergySeverity } from "./allergy.model.js";

export type { Allergy } from "./allergy.repository.js";

export interface RecordAllergyInput {
  patientId: string;
  allergen: string;
  severity: AllergySeverity;
  reaction?: string;
}

/**
 * The human-readable label for an allergen code. Small, but it belongs to the service, not
 * the wire: the API returns `{ allergen: "penicillins", label: "Penicillins" }` so the UI
 * never has to carry its own copy of the catalogue and drift from it.
 */
export function labelFor(allergen: string): string {
  return isAllergen(allergen) ? ALLERGENS[allergen as Allergen] : allergen;
}

function decorate(a: repo.Allergy): repo.Allergy & { label: string } {
  return { ...a, label: labelFor(a.allergen) };
}

/**
 * Records an allergy against a patient.
 *
 * The patient must exist — recording an allergy against a patientId nobody registered is a
 * fact attached to nothing, and the likeliest cause is an id typo that would then never fire
 * the check for the real patient.
 */
export async function recordAllergy(
  input: RecordAllergyInput,
): Promise<repo.Allergy & { label: string }> {
  // Defence in depth: the DTO already constrains this, but the service is reachable from a
  // future internal caller, and an un-catalogued allergen is one the check can never match.
  if (!isAllergen(input.allergen)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      allergen: [`unknown allergen "${input.allergen}" — must be one of the catalogue codes`],
    });
  }

  // `getPatient` throws HMS-PAT-001 if the id names no one — the patients module owns that
  // error, and it is more specific than a generic 404. Recording an allergy against a
  // patient who does not exist is a fact attached to nothing, most likely an id typo that
  // would then never fire the check for the real patient.
  const patient = await getPatient(input.patientId);

  try {
    const created = await repo.create({
      patientId: input.patientId,
      allergen: input.allergen,
      severity: input.severity,
      ...(input.reaction ? { reaction: input.reaction } : {}),
      ...(patient.branchId ? { branchId: patient.branchId } : {}),
    });
    return decorate(created);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-ALLERGY-001", 409, "That allergy is already on the list", {
        patientId: input.patientId,
        allergen: input.allergen,
        hint: "it is already recorded as active — refute it first if it was entered in error",
      });
    }
    throw err;
  }
}

/** The whole list — active and refuted — for the management screen. */
export async function listAllergies(
  patientId: string,
): Promise<(repo.Allergy & { label: string })[]> {
  const rows = await repo.listForPatient(patientId);
  return rows.map(decorate);
}

/** The active allergens the prescribing check screens against. */
export async function activeAllergies(patientId: string): Promise<repo.Allergy[]> {
  return repo.listActiveForPatient(patientId);
}

/** Rules an allergy out. Refused if it is already refuted — that is not an error to hide. */
export async function refuteAllergy(
  id: string,
  reason: string,
): Promise<repo.Allergy & { label: string }> {
  const existing = await repo.findById(id);
  if (!existing) {
    throw new AppError("HMS-GEN-404", 404, "Allergy not found", { id });
  }

  const refuted = await repo.refute(id, reason);
  if (!refuted) {
    // The CAS matched on `status: active`; a miss means it was refuted between our read and
    // our write. Name the state rather than just failing.
    throw new AppError("HMS-STATE-001", 422, "That allergy has already been ruled out", {
      id,
      status: existing.status,
    });
  }
  return decorate(refuted);
}
