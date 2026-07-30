/**
 * MRD DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const icd = z.string().trim().min(1).max(16);

export const createIcdSchema = z
  .object({
    code: icd,
    title: z.string().trim().min(1).max(300),
    chapter: z.string().trim().max(120).optional(),
  })
  .strict();

export const updateIcdSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    chapter: z.string().trim().max(120).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const listIcdQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

const codedDiagnosis = z
  .object({
    code: icd,
    title: z.string().trim().min(1).max(300),
    primary: z.boolean().default(false),
  })
  .strict();

export const saveCodingSchema = z.object({ codes: z.array(codedDiagnosis).max(40) }).strict();

export const idParamSchema = z.object({ id: objectId }).strict();
export const encounterParamSchema = z.object({ encounterId: objectId }).strict();
export const registerQuerySchema = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .strict();

export type CreateIcdBody = z.infer<typeof createIcdSchema>;
export type UpdateIcdBody = z.infer<typeof updateIcdSchema>;
export type ListIcdQuery = z.infer<typeof listIcdQuerySchema>;
export type SaveCodingBody = z.infer<typeof saveCodingSchema>;
export type RegisterQuery = z.infer<typeof registerQuerySchema>;
