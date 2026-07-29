/**
 * Consultation note DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { DIAGNOSIS_TYPES } from "./consultation.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

const diagnosisSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    code: z.string().trim().max(32).optional(),
    type: z.enum(DIAGNOSIS_TYPES),
  })
  .strict();

/**
 * Every field is optional — a consultation is written incrementally, and a save may touch only the
 * examination or only the plan. `.refine` stops a completely empty PUT from being a no-op write.
 */
export const saveConsultationSchema = z
  .object({
    chiefComplaint: z.string().trim().max(1000).optional(),
    history: z.string().trim().max(4000).optional(),
    examination: z.string().trim().max(4000).optional(),
    diagnoses: z.array(diagnosisSchema).max(20).optional(),
    plan: z.string().trim().max(4000).optional(),
    followUpDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to save" });

export const encounterIdParamSchema = z.object({ id: objectId }).strict();

export type SaveConsultationBody = z.infer<typeof saveConsultationSchema>;
