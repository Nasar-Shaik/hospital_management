/**
 * Prescription response contracts.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { ALLERGENS } from "../drugSafety/index.js";
import { DRUG_FREQUENCIES, DRUG_ROUTES, PRESCRIPTION_STATUSES } from "./prescription.model.js";
import type { Prescription } from "./prescription.repository.js";
import type { PrescriptionScreening } from "./prescription.service.js";
import type { Allergen, SafetyAlert } from "../drugSafety/index.js";

const prescriptionStatus = z.enum(PRESCRIPTION_STATUSES);
/** The literal key union, not a bare string — an allergen a machine cannot match is a
 * safety check that silently never fires. */
const allergen = z.enum(Object.keys(ALLERGENS) as [Allergen, ...Allergen[]]);

export const prescriptionLine = contract(
  "PrescriptionLine",
  z.object({
    /** The tariff/drug-master code — this is what gets charged at dispense. */
    drugCode: z.string(),
    /** Denormalized, so renaming the drug master never rewrites a signed prescription. */
    drugName: z.string(),
    /** `500 mg`, `5 ml`, `1 puff` — the unit is part of the instruction. */
    dose: z.string(),
    route: z.enum(DRUG_ROUTES),
    frequency: z.enum(DRUG_FREQUENCIES),
    durationDays: z.number().optional(),
    /** How many units to hand over. This — not the dose — is what the pharmacy counts. */
    quantity: z.number(),
    /** How many have actually been handed over. The gap is `partially_dispensed`. */
    dispensedQty: z.number(),
    instructions: z.string().optional(),
  }),
);

export const prescriptionHistoryEntry = contract(
  "PrescriptionHistoryEntry",
  z.object({
    from: prescriptionStatus,
    to: prescriptionStatus,
    at: z.string(),
    by: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export const prescription = contract(
  "Prescription",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    status: prescriptionStatus,
    lines: z.array(prescriptionLine),
    prescribedBy: z.string(),
    prescribedAt: z.string(),
    signedBy: z.string().optional(),
    signedAt: z.string().optional(),
    /** The `pharmacy` order this raised. Absent when the hospital dispenses externally. */
    orderId: z.string().optional(),
    version: z.number(),
    supersedesId: z.string().optional(),
    supersededById: z.string().optional(),
    cancelReason: z.string().optional(),
    notes: z.string().optional(),
    /** Recorded when a prescriber signed THROUGH a safety alert — the alerts are kept verbatim. */
    safetyOverride: z
      .object({
        reason: z.string(),
        by: z.string(),
        at: z.string(),
        alerts: z.array(
          z.object({
            kind: z.string(),
            severity: z.string(),
            allergen: z.string().optional(),
            message: z.string(),
          }),
        ),
      })
      .optional(),
    branchId: z.string().optional(),
    history: z.array(prescriptionHistoryEntry),
    createdAt: z.string(),
  }),
);
export type PrescriptionProof = Proves<Matches<typeof prescription, Prescription>>;

export const safetyAlert = contract(
  "SafetyAlert",
  z.object({
    kind: z.enum(["allergy", "cross_sensitivity", "duplicate_therapy", "interaction"]),
    severity: z.enum(["contraindicated", "major", "moderate"]),
    /** The prescribed drug code(s) this alert is about. */
    drugCodes: z.array(z.string()),
    /** Set on allergy/cross-sensitivity alerts: the allergen that fired it. */
    allergen: allergen.optional(),
    message: z.string(),
  }),
);
export type SafetyAlertProof = Proves<Matches<typeof safetyAlert, SafetyAlert>>;

export const prescriptionScreening = contract(
  "PrescriptionScreening",
  z.object({
    prescriptionId: z.string(),
    alerts: z.array(safetyAlert),
    /** True when at least one alert is a contraindication. */
    blocking: z.boolean(),
  }),
);
export type PrescriptionScreeningProof = Proves<
  Matches<typeof prescriptionScreening, PrescriptionScreening>
>;
