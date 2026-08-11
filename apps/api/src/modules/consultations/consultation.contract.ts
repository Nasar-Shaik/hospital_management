/**
 * Consultation note response contract.
 *
 * `GET` answers `null` when the doctor has not written one yet — a real state, and the contract
 * says so rather than pretending an empty note exists.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { DIAGNOSIS_TYPES } from "./consultation.model.js";
import type { ConsultationNote } from "./consultation.repository.js";

export const diagnosis = contract(
  "Diagnosis",
  z.object({
    /** The condition in words — always present; a code without a name is unreadable at the bedside. */
    text: z.string(),
    /** ICD-10 / local code, when the doctor supplies one. */
    code: z.string().optional(),
    type: z.enum(DIAGNOSIS_TYPES),
  }),
);

export const consultationNote = contract(
  "ConsultationNote",
  z.object({
    encounterId: z.string(),
    patientId: z.string(),
    doctorId: z.string().optional(),
    chiefComplaint: z.string().optional(),
    history: z.string().optional(),
    examination: z.string().optional(),
    diagnoses: z.array(diagnosis),
    plan: z.string().optional(),
    followUpDays: z.number().optional(),
    branchId: z.string().optional(),
    updatedAt: z.string(),
  }),
);
export type ConsultationNoteProof = Proves<Matches<typeof consultationNote, ConsultationNote>>;
