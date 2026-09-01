/**
 * General store DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * No `branchId` anywhere, deliberately. The site a movement belongs to is resolved from the
 * request context by `writeBranchId()`, never taken from the body: a `branchId` in a mutation
 * payload is an instruction to write somewhere, and five services once trusted one (see
 * `assertWritableBranch`). A `.strict()` schema that never names the field is the cheapest
 * possible version of that guard.
 */
import { z } from "@medicore/validation";
import { ITEM_CATEGORIES, ITEM_UNITS } from "./inventory.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const positiveInt = z.number().int().positive();

export const createItemSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    category: z.enum(ITEM_CATEGORIES),
    unit: z.enum(ITEM_UNITS),
    reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const updateItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.enum(ITEM_CATEGORIES).optional(),
    unit: z.enum(ITEM_UNITS).optional(),
    reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const receiveSchema = z
  .object({
    quantity: positiveInt.max(1_000_000),
    supplierId: objectId.optional(),
    invoiceRef: z.string().trim().max(120).optional(),
    /** Per unit, as printed on the invoice. Recorded; never posted to a ledger. */
    unitCost: z.number().min(0).max(10_000_000).optional(),
  })
  .strict();

export const issueSchema = z
  .object({
    quantity: positiveInt.max(1_000_000),
    /** Required: stock that leaves the store must arrive somewhere nameable. */
    departmentId: objectId,
  })
  .strict();

export const adjustSchema = z
  .object({
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, { message: "an adjustment cannot be zero" }),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export const createSupplierSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().email().max(200).optional(),
    taxId: z.string().trim().max(64).optional(),
  })
  .strict();

export const updateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().email().max(200).optional(),
    taxId: z.string().trim().max(64).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const storeQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    lowStockOnly: z.enum(["true", "false"]).optional(),
    includeInactive: z.enum(["true", "false"]).optional(),
  })
  .strict();

export const supplierQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    includeInactive: z.enum(["true", "false"]).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateItemBody = z.infer<typeof createItemSchema>;
export type UpdateItemBody = z.infer<typeof updateItemSchema>;
export type ReceiveBody = z.infer<typeof receiveSchema>;
export type IssueBody = z.infer<typeof issueSchema>;
export type AdjustBody = z.infer<typeof adjustSchema>;
export type CreateSupplierBody = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierBody = z.infer<typeof updateSupplierSchema>;
export type StoreQuery = z.infer<typeof storeQuerySchema>;
export type SupplierQuery = z.infer<typeof supplierQuerySchema>;
