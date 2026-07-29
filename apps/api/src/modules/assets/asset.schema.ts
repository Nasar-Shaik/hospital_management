/**
 * Asset + maintenance DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { ASSET_CATEGORIES, ASSET_STATUSES, MAINTENANCE_TYPES } from "./asset.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
/** A money amount in PAISE — a non-negative integer, like every amount in the system. */
const paise = z.number().int().min(0).max(1_000_000_000);

export const createAssetSchema = z
  .object({
    assetTag: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(120),
    category: z.enum(ASSET_CATEGORIES),
    location: z.string().trim().max(120).optional(),
    manufacturer: z.string().trim().max(120).optional(),
    modelNumber: z.string().trim().max(80).optional(),
    serialNumber: z.string().trim().max(80).optional(),
    purchaseDate: isoDate.optional(),
    purchaseCost: paise.optional(),
    warrantyExpiry: isoDate.optional(),
    serviceIntervalDays: z.number().int().min(1).max(3650).optional(),
    nextServiceDue: isoDate.optional(),
  })
  .strict();

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    location: z.string().trim().max(120).optional(),
    manufacturer: z.string().trim().max(120).optional(),
    modelNumber: z.string().trim().max(80).optional(),
    serialNumber: z.string().trim().max(80).optional(),
    purchaseDate: isoDate.optional(),
    purchaseCost: paise.optional(),
    warrantyExpiry: isoDate.optional(),
    serviceIntervalDays: z.number().int().min(1).max(3650).optional(),
    nextServiceDue: isoDate.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const addMaintenanceSchema = z
  .object({
    type: z.enum(MAINTENANCE_TYPES),
    performedOn: isoDate,
    performedBy: z.string().trim().max(120).optional(),
    cost: paise.optional(),
    notes: z.string().trim().max(1000).optional(),
    nextServiceDue: isoDate.optional(),
  })
  .strict();

export const listAssetsQuerySchema = z
  .object({
    status: z.enum(ASSET_STATUSES).optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateAssetBody = z.infer<typeof createAssetSchema>;
export type UpdateAssetBody = z.infer<typeof updateAssetSchema>;
export type AddMaintenanceBody = z.infer<typeof addMaintenanceSchema>;
export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;
