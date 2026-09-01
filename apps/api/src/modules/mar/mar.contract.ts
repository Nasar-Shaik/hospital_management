/**
 * Medication administration response contract — the ward's drug round record.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { MAR_STATUSES } from "./mar.model.js";
import type { MedicationAdministration } from "./mar.repository.js";
import type { DoseSlotView } from "./mar.service.js";

export const medicationAdministration = contract(
  "MedicationAdministration",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    prescriptionId: z.string(),
    /** Which line of the prescription. Absent on rows charted before M3-S1. */
    lineIndex: z.number().optional(),
    /** Denormalized, so the round survives the prescription being superseded. */
    drugCode: z.string(),
    drugName: z.string(),
    dose: z.string(),
    route: z.string(),
    /** `held`, `refused` and `not_available` are records too — a dose not given is a fact. */
    status: z.enum(MAR_STATUSES),
    /** The dose slot answered. Absent for PRN, which has no slots and is repeatable. */
    scheduledFor: z.string().optional(),
    administeredAt: z.string(),
    reason: z.string().optional(),
    note: z.string().optional(),
    administeredBy: z.string().optional(),
  }),
);
export type MedicationAdministrationProof = Proves<
  Matches<typeof medicationAdministration, MedicationAdministration>
>;

/**
 * One dose the schedule says is expected, and what happened to it.
 *
 * `state` mixes recorded outcomes with two derived ones (`due`, `overdue`). Derived server-side
 * and deliberately: whether a dose is late depends on the ward's clock, and a phone in the wrong
 * timezone — or simply set wrong — must not be what decides.
 */
export const doseSlot = contract(
  "DoseSlot",
  z.object({
    prescriptionId: z.string(),
    lineIndex: z.number(),
    drugCode: z.string(),
    drugName: z.string(),
    dose: z.string(),
    route: z.string(),
    frequency: z.string(),
    scheduledFor: z.string(),
    state: z.enum([...MAR_STATUSES, "due", "overdue"]),
    administrationId: z.string().optional(),
    administeredAt: z.string().optional(),
    administeredBy: z.string().optional(),
    reason: z.string().optional(),
  }),
);
export type DoseSlotProof = Proves<Matches<typeof doseSlot, DoseSlotView>>;
