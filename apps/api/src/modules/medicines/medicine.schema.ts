/**
 * Medicine master + stock DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { MEDICINE_FORMS } from "./medicine.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/** Optional positive integers for packaging counts — a strip has whole tablets, never 2.5. */
const positiveInt = z.number().int().positive();

export const createMedicineSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    manufacturer: z.string().trim().max(200).optional(),
    generic: z.string().trim().max(300).optional(),
    form: z.enum(MEDICINE_FORMS),
    strength: z.string().trim().max(80).optional(),
    unitsPerSheet: positiveInt.max(10_000).optional(),
    sheetsPerPack: positiveInt.max(10_000).optional(),
    reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const updateMedicineSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    manufacturer: z.string().trim().max(200).optional(),
    generic: z.string().trim().max(300).optional(),
    form: z.enum(MEDICINE_FORMS).optional(),
    strength: z.string().trim().max(80).optional(),
    unitsPerSheet: positiveInt.max(10_000).optional(),
    sheetsPerPack: positiveInt.max(10_000).optional(),
    reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const receiveStockSchema = z
  .object({
    quantity: positiveInt.max(1_000_000),
    batchNo: z.string().trim().max(80).optional(),
    /** ISO date string; coerced to a Date at the controller edge, never here. */
    expiry: z.string().datetime().optional(),
  })
  .strict();

export const adjustStockSchema = z
  .object({
    /** Signed: negative writes stock off, positive corrects it up. Non-zero. */
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, { message: "an adjustment cannot be zero" }),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export const listQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    lowStockOnly: z.enum(["true", "false"]).optional(),
    includeInactive: z.enum(["true", "false"]).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateMedicineBody = z.infer<typeof createMedicineSchema>;
export type UpdateMedicineBody = z.infer<typeof updateMedicineSchema>;
export type ReceiveStockBody = z.infer<typeof receiveStockSchema>;
export type AdjustStockBody = z.infer<typeof adjustStockSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * `?codes=PARA500,AMOX500` — the prescribing screen asks about the drugs on the pad, never the
 * whole formulary. Comma-separated, matching `/billing/order-payments` and `/reports`, which the
 * same screens already call the same way.
 */
export const availabilityQuerySchema = z.object({ codes: z.string().min(1).max(2_000) }).strict();

export const codeParamSchema = z.object({ code: z.string().min(1).max(64) }).strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
