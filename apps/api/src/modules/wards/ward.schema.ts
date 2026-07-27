/**
 * Ward & bed DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { WARD_KINDS } from "./ward.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const createWardSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(WARD_KINDS),
    /** The default bed-day tariff for the ward — a real tariff code, checked when the bill posts. */
    tariffCode: z.string().trim().min(1).max(64),
  })
  .strict();

export const updateWardSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(WARD_KINDS).optional(),
    tariffCode: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const createBedSchema = z
  .object({
    wardId: objectId,
    code: z.string().trim().min(1).max(32),
    room: z.string().trim().max(32).optional(),
    /** Overrides the ward's tariff for this bed; omit to bill at the ward's rate. */
    tariffCode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const updateBedSchema = z
  .object({
    code: z.string().trim().min(1).max(32).optional(),
    room: z.string().trim().max(32).optional(),
    tariffCode: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["available", "blocked"]).optional(),
    blockedReason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const listBedsQuerySchema = z.object({ wardId: objectId.optional() }).strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateWardBody = z.infer<typeof createWardSchema>;
export type UpdateWardBody = z.infer<typeof updateWardSchema>;
export type CreateBedBody = z.infer<typeof createBedSchema>;
export type UpdateBedBody = z.infer<typeof updateBedSchema>;
export type ListBedsQuery = z.infer<typeof listBedsQuerySchema>;
