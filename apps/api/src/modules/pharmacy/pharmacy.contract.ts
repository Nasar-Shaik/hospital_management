/**
 * Pharmacy response contracts — what actually crossed the counter.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { prescription } from "../prescriptions/prescription.contract.js";
import type { Dispense } from "./dispense.repository.js";
import type { DispenseResult } from "./pharmacy.service.js";

export const dispenseLine = contract(
  "DispenseLine",
  z.object({
    /** WHICH line of the prescription — the position, because the same drug can appear twice. */
    lineIndex: z.number(),
    /** Denormalized, so what was handed over survives the prescription being superseded. */
    drugCode: z.string(),
    drugName: z.string(),
    /** How many units crossed the counter in THIS handover. Never the prescribed total. */
    quantity: z.number(),
  }),
);

export const dispense = contract(
  "Dispense",
  z.object({
    id: z.string(),
    prescriptionId: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    orderId: z.string().optional(),
    lines: z.array(dispenseLine),
    dispensedBy: z.string(),
    dispensedAt: z.string(),
    requestId: z.string().optional(),
    branchId: z.string().optional(),
    /** Set when the handover was authorised on credit against an admitted patient's advance. */
    creditOverride: z
      .object({
        by: z.string(),
        reason: z.string(),
        shortfall: z.number(),
        at: z.string(),
      })
      .optional(),
    createdAt: z.string(),
  }),
);
export type DispenseProof = Proves<Matches<typeof dispense, Dispense>>;

/** 201 for a handover, 200 when this `requestId` had already been dispensed — never a second lot. */
export const dispenseResult = contract(
  "DispenseResult",
  z.object({ dispense, prescription, duplicate: z.boolean() }),
);
export type DispenseResultProof = Proves<Matches<typeof dispenseResult, DispenseResult>>;
