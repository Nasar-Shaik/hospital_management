/**
 * Medical records department response contracts — ICD coding and the disease register.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { DiseaseRegisterRow, EncounterCoding, IcdCode } from "./mrd.repository.js";

export const icdCode = contract(
  "IcdCode",
  z.object({
    id: z.string(),
    code: z.string(),
    title: z.string(),
    chapter: z.string().optional(),
    active: z.boolean(),
  }),
);
export type IcdCodeProof = Proves<Matches<typeof icdCode, IcdCode>>;

export const codedDiagnosis = contract(
  "CodedDiagnosis",
  z.object({
    code: z.string(),
    title: z.string(),
    /** Exactly one coding is primary — it is what the disease register counts. */
    primary: z.boolean(),
  }),
);

export const encounterCoding = contract(
  "EncounterCoding",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    codes: z.array(codedDiagnosis),
    codedBy: z.string().optional(),
    codedAt: z.string(),
  }),
);
export type EncounterCodingProof = Proves<Matches<typeof encounterCoding, EncounterCoding>>;

export const diseaseRegisterRow = contract(
  "DiseaseRegisterRow",
  z.object({ code: z.string(), title: z.string(), cases: z.number() }),
);
export type DiseaseRegisterRowProof = Proves<
  Matches<typeof diseaseRegisterRow, DiseaseRegisterRow>
>;
