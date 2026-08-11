/**
 * Medication administration response contract — the ward's drug round record.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { MAR_STATUSES } from "./mar.model.js";
import type { MedicationAdministration } from "./mar.repository.js";

export const medicationAdministration = contract(
  "MedicationAdministration",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    prescriptionId: z.string(),
    /** Denormalized, so the round survives the prescription being superseded. */
    drugCode: z.string(),
    drugName: z.string(),
    dose: z.string(),
    route: z.string(),
    /** `held`, `refused` and `not_available` are records too — a dose not given is a fact. */
    status: z.enum(MAR_STATUSES),
    administeredAt: z.string(),
    reason: z.string().optional(),
    note: z.string().optional(),
    administeredBy: z.string().optional(),
  }),
);
export type MedicationAdministrationProof = Proves<
  Matches<typeof medicationAdministration, MedicationAdministration>
>;
