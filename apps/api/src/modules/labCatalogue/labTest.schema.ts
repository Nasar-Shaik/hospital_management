/**
 * Lab test catalogue DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

const analyteSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    label: z.string().trim().min(1).max(120),
    unit: z.string().trim().max(32).optional(),
    refLow: z.number().optional(),
    refHigh: z.number().optional(),
    refText: z.string().trim().max(64).optional(),
  })
  .strict();

export const createLabTestSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    specimenType: z.string().trim().max(120).optional(),
    analytes: z.array(analyteSchema).max(60).optional(),
  })
  .strict();

export const updateLabTestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    specimenType: z.string().trim().max(120).optional(),
    analytes: z.array(analyteSchema).max(60).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const listLabTestsQuerySchema = z
  .object({ includeInactive: z.coerce.boolean().optional() })
  .strict();

export const codeParamSchema = z.object({ code: z.string().trim().min(1).max(64) }).strict();
export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateLabTestBody = z.infer<typeof createLabTestSchema>;
export type UpdateLabTestBody = z.infer<typeof updateLabTestSchema>;
export type ListLabTestsQuery = z.infer<typeof listLabTestsQuerySchema>;
