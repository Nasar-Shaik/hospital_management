/**
 * MRD service (Module MRD) — the ICD-10 master, encounter coding, and the disease register.
 *
 * Coding hangs off a real encounter, so the service's job is to establish the visit exists and learn
 * whose it is before writing the coded diagnosis — the patient and episode are DERIVED from the
 * encounter, never trusted from the caller. Depends on `encounters`; nothing reads back, so the
 * graph stays acyclic (mrd → encounters).
 */
import { AppError } from "../../core/errors/appError.js";
import { getEncounter } from "../encounters/index.js";
import * as repo from "./mrd.repository.js";

export type {
  IcdCode,
  EncounterCoding,
  DiseaseRegisterRow,
  CodedDiagnosis,
} from "./mrd.repository.js";

export const listIcd = repo.listIcd;
/** Does this hospital's ICD master recognise this code? Used by the problem list. */
export const findActiveIcdByCode = repo.findActiveIcdByCode;
export const getCoding = repo.getCoding;
export const diseaseRegister = repo.diseaseRegister;

export async function createIcd(input: repo.CreateIcdInput): Promise<repo.IcdCode> {
  try {
    return await repo.createIcd(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That ICD code already exists", {
        code: input.code,
        hint: "ICD codes are unique per hospital",
      });
    }
    throw err;
  }
}

export async function updateIcd(
  id: string,
  patch: { title?: string; chapter?: string; active?: boolean },
): Promise<repo.IcdCode> {
  const updated = await repo.updateIcd(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "ICD code not found", { id });
  return updated;
}

export async function saveCoding(
  encounterId: string,
  codes: repo.CodedDiagnosis[],
): Promise<repo.EncounterCoding> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { encounterId });

  // Exactly one primary diagnosis: the register counts primaries, and a coding with two (or none)
  // would either double-count the visit or drop it. Normalise here rather than trust the client.
  const primaries = codes.filter((c) => c.primary).length;
  if (codes.length > 0 && primaries !== 1) {
    throw new AppError("HMS-VAL-001", 422, "Mark exactly one diagnosis as primary", {
      primaries,
      hint: "the primary is the main condition treated — the register counts it",
    });
  }

  return repo.upsertCoding({
    encounterId,
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    codes,
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });
}
