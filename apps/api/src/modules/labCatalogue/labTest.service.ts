/**
 * Lab test catalogue service (Module D6 / LIS depth).
 *
 * Thin over the repository: it turns a duplicate test code into the hospital's own sentence, and
 * fills in each analyte's printable range (`refText`) from its numbers when the author left it
 * blank — so the master is consistent whether the range was typed as words or as bounds.
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./labTest.repository.js";
import type { Analyte } from "./labTest.model.js";

export type { LabTest } from "./labTest.repository.js";
export type { Analyte } from "./labTest.model.js";

export const listTests = repo.listTests;
export const getTestByCode = repo.findByCode;

/** Derive the printable range from the numeric bounds when the author did not supply one. */
function withDerivedRange(a: Analyte): Analyte {
  if (a.refText?.trim()) return a;
  let refText: string | undefined;
  if (a.refLow != null && a.refHigh != null) refText = `${a.refLow}–${a.refHigh}`;
  else if (a.refLow != null) refText = `> ${a.refLow}`;
  else if (a.refHigh != null) refText = `< ${a.refHigh}`;
  return refText ? { ...a, refText } : a;
}

export async function createTest(input: repo.CreateLabTestInput): Promise<repo.LabTest> {
  const analytes = (input.analytes ?? []).map(withDerivedRange);
  try {
    return await repo.createTest({ ...input, analytes });
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That test code already exists", {
        code: input.code,
        hint: "lab test codes are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateTest(
  id: string,
  patch: repo.UpdateLabTestInput,
): Promise<repo.LabTest> {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Lab test not found", { id });
  const next = patch.analytes
    ? { ...patch, analytes: patch.analytes.map(withDerivedRange) }
    : patch;
  const updated = await repo.updateTest(id, next);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Lab test not found", { id });
  return updated;
}
