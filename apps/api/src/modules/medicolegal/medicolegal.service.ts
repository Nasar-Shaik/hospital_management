/**
 * Medico-legal records service (Module C3) — informed consent and the statutory death record.
 *
 * Both records answer to a PATIENT and hang off a VISIT, so the service's job is the same for each:
 * establish that the encounter is real and learn whose it is BEFORE writing PHI, so a consent or a
 * death can never be filed against an encounter that does not exist or a patient it is not for. The
 * storage lives in two repositories (one per collection, Constitution §6); this composes them with
 * the encounter spine it depends on. The dependency is one-way — medico-legal → encounters — so the
 * module graph stays acyclic.
 */
import { AppError } from "../../core/errors/appError.js";
import { getEncounter } from "../encounters/index.js";
import { getPatient } from "../patients/index.js";
import * as consents from "./consent.repository.js";
import * as deaths from "./deathRecord.repository.js";

export type { Consent } from "./consent.repository.js";
export type { DeathRecord } from "./deathRecord.repository.js";

export const listConsents = consents.listForPatient;
export const getConsent = consents.findById;
export const getDeathRecordForEncounter = deaths.findForEncounter;
export const getDeathRecordForPatient = deaths.findForPatient;

/** Load the encounter and confirm it is this patient's — the guard both records share. */
async function encounterForPatient(encounterId: string, patientId: string): Promise<void> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });
  if (encounter.patientId !== patientId) {
    throw new AppError("HMS-VAL-001", 422, "That visit is not this patient's", {
      encounterId,
      patientId,
      hint: "the consent's patient and the visit's patient must match",
    });
  }
}

export type RecordConsentInput = consents.CreateConsentInput;

export async function recordConsent(input: RecordConsentInput): Promise<consents.Consent> {
  // The consent is about a patient — they must exist before we file PHI against them.
  const patient = await getPatient(input.patientId);
  if (!patient)
    throw new AppError("HMS-GEN-404", 404, "Patient not found", { id: input.patientId });
  if (input.encounterId) await encounterForPatient(input.encounterId, input.patientId);

  // A signer who is not the patient must say who they are — an unnamed relative's consent is no
  // consent at all. (The patient signing for themselves needs no relationship.)
  if (input.signedBy !== "patient" && !input.relationship?.trim()) {
    throw new AppError("HMS-VAL-001", 422, "Say the signer's relationship to the patient", {
      signedBy: input.signedBy,
      hint: "relationship is required when the patient did not sign",
    });
  }
  return consents.create(input);
}

export async function withdrawConsent(id: string, reason: string): Promise<consents.Consent> {
  const updated = await consents.withdraw(id, reason);
  if (!updated) {
    // Either it does not exist, or it is already withdrawn — the repo only touches active ones.
    const existing = await consents.findById(id);
    if (!existing) throw new AppError("HMS-GEN-404", 404, "Consent not found", { id });
    throw new AppError("HMS-STATE-001", 409, "That consent is already withdrawn", {
      id,
      status: existing.status,
    });
  }
  return updated;
}

export type RecordDeathInput = Omit<deaths.CreateDeathRecordInput, "patientId">;

export async function recordDeath(input: RecordDeathInput): Promise<deaths.DeathRecord> {
  // The encounter is the source of truth for whose death this is — derive the patient from it
  // rather than trusting a patientId the caller could get wrong.
  const encounter = await getEncounter(input.encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", {
      encounterId: input.encounterId,
    });
  }
  try {
    return await deaths.create({ ...input, patientId: encounter.patientId });
  } catch (err) {
    if (deaths.isDuplicateKey(err)) {
      throw new AppError("HMS-STATE-001", 409, "This visit already has a death record", {
        encounterId: input.encounterId,
        hint: "a death is recorded once per stay — open the existing record",
      });
    }
    throw err;
  }
}
