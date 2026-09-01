/**
 * Problem list DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * The ICD code is NOT an enum here, unlike the allergen catalogue: `ALLERGENS` is a fixed list
 * compiled into the product, while the ICD master is per-hospital data that an administrator
 * edits. So the edge checks its SHAPE and the service checks its EXISTENCE against that
 * hospital's master (`problem.service.validatedCode`).
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const addProblemSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    code: z.string().trim().max(16).optional(),
    onsetDate: z.coerce.date().optional(),
  })
  .strict();

export const promoteProblemSchema = z
  .object({
    /** Which entry in the visit's `diagnoses[]`. The note is the source; the index is the choice. */
    diagnosisIndex: z.number().int().min(0).max(19),
    code: z.string().trim().max(16).optional(),
    onsetDate: z.coerce.date().optional(),
  })
  .strict();

export const resolveProblemSchema = z
  .object({
    /**
     * OPTIONAL, unlike an allergy's refutation reason. Refuting an allergy switches off a safety
     * alert and must be justified; a resolved problem is ordinary clinical progress ("the
     * pneumonia cleared"), and demanding a sentence for it would buy nothing but friction.
     */
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const patientIdParamSchema = z.object({ patientId: objectId }).strict();
export const idParamSchema = z.object({ id: objectId }).strict();

export type AddProblemBody = z.infer<typeof addProblemSchema>;
export type PromoteProblemBody = z.infer<typeof promoteProblemSchema>;
export type ResolveProblemBody = z.infer<typeof resolveProblemSchema>;
