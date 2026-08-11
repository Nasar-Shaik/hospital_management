/**
 * Vitals response contracts — the reading plus the assessment made of it.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { TRIAGE_LEVELS } from "./vitals.model.js";
import { VITAL_FIELDS } from "./vitals.repository.js";
import type { AssessedVitals } from "./vitals.service.js";

const vitalFlag = z.enum(["low", "normal", "high"]);

export const assessedVitals = contract(
  "AssessedVitals",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    systolic: z.number().optional(),
    diastolic: z.number().optional(),
    pulse: z.number().optional(),
    respiratoryRate: z.number().optional(),
    temperature: z.number().optional(),
    spo2: z.number().optional(),
    weightKg: z.number().optional(),
    heightCm: z.number().optional(),
    painScore: z.number().optional(),
    triageLevel: z.enum(TRIAGE_LEVELS).optional(),
    notes: z.string().optional(),
    recordedBy: z.string(),
    recordedAt: z.string(),
    branchId: z.string().optional(),
    /** Per-field flags. Only fields that were recorded AND have a range appear. */
    flags: z.object(
      Object.fromEntries(VITAL_FIELDS.map((f) => [f, vitalFlag.optional()])) as {
        [K in (typeof VITAL_FIELDS)[number]]: z.ZodOptional<typeof vitalFlag>;
      },
    ),
    /** True when at least one recorded value is outside its range — the "look here" bit. */
    abnormal: z.boolean(),
    bmi: z.number().optional(),
  }),
);
export type AssessedVitalsProof = Proves<Matches<typeof assessedVitals, AssessedVitals>>;
