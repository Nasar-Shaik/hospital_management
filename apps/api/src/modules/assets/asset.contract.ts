/**
 * Asset register response contracts — equipment and its service history.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { ASSET_CATEGORIES, ASSET_STATUSES, MAINTENANCE_TYPES } from "./asset.model.js";
import type { Asset, AssetMaintenance } from "./asset.repository.js";

export const asset = contract(
  "Asset",
  z.object({
    id: z.string(),
    /** The sticker on the machine — the hospital's own key for it. */
    assetTag: z.string(),
    name: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    status: z.enum(ASSET_STATUSES),
    location: z.string().optional(),
    manufacturer: z.string().optional(),
    modelNumber: z.string().optional(),
    serialNumber: z.string().optional(),
    purchaseDate: z.string().optional(),
    /** Paise. */
    purchaseCost: z.number().int().optional(),
    warrantyExpiry: z.string().optional(),
    serviceIntervalDays: z.number().optional(),
    nextServiceDue: z.string().optional(),
    lastServicedOn: z.string().optional(),
    notes: z.string().optional(),
    branchId: z.string().optional(),
  }),
);
export type AssetProof = Proves<Matches<typeof asset, Asset>>;

export const assetMaintenance = contract(
  "AssetMaintenance",
  z.object({
    id: z.string(),
    assetId: z.string(),
    type: z.enum(MAINTENANCE_TYPES),
    performedOn: z.string(),
    performedBy: z.string().optional(),
    /** Paise. */
    cost: z.number().int().optional(),
    notes: z.string().optional(),
    nextServiceDue: z.string().optional(),
    branchId: z.string().optional(),
  }),
);
export type AssetMaintenanceProof = Proves<Matches<typeof assetMaintenance, AssetMaintenance>>;
