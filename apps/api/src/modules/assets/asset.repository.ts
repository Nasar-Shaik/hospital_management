/**
 * Asset + maintenance repository — the ONLY code that queries `assets` / `assetMaintenance`
 * (Constitution §6).
 *
 * Branch-aware like every operational collection: reads pass through `scopeFilter()` so a
 * user confined to one site sees only its estate, and writes stamp the active `branchId`.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getAssetModel,
  getAssetMaintenanceModel,
  type AssetDoc,
  type AssetMaintenanceDoc,
  type AssetCategory,
  type AssetStatus,
  type MaintenanceType,
} from "./asset.model.js";

export { isDuplicateKey };

/* ── Assets ──────────────────────────────────────────────────────────────────── */

export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  serviceIntervalDays?: number;
  nextServiceDue?: string;
  lastServicedOn?: string;
  notes?: string;
  branchId?: string;
}

function toAsset(doc: AssetDoc): Asset {
  return {
    id: doc._id.toString(),
    assetTag: doc.assetTag,
    name: doc.name,
    category: doc.category,
    status: doc.status,
    ...(doc.location ? { location: doc.location } : {}),
    ...(doc.manufacturer ? { manufacturer: doc.manufacturer } : {}),
    ...(doc.modelNumber ? { modelNumber: doc.modelNumber } : {}),
    ...(doc.serialNumber ? { serialNumber: doc.serialNumber } : {}),
    ...(doc.purchaseDate ? { purchaseDate: doc.purchaseDate } : {}),
    ...(doc.purchaseCost != null ? { purchaseCost: doc.purchaseCost } : {}),
    ...(doc.warrantyExpiry ? { warrantyExpiry: doc.warrantyExpiry } : {}),
    ...(doc.serviceIntervalDays != null ? { serviceIntervalDays: doc.serviceIntervalDays } : {}),
    ...(doc.nextServiceDue ? { nextServiceDue: doc.nextServiceDue } : {}),
    ...(doc.lastServicedOn ? { lastServicedOn: doc.lastServicedOn } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateAssetInput {
  assetTag: string;
  name: string;
  category: AssetCategory;
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  serviceIntervalDays?: number;
  nextServiceDue?: string;
}

export async function createAsset(input: CreateAssetInput): Promise<Asset> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getAssetModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    assetTag: input.assetTag.toUpperCase(),
    name: input.name,
    category: input.category,
    ...(input.location ? { location: input.location } : {}),
    ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
    ...(input.modelNumber ? { modelNumber: input.modelNumber } : {}),
    ...(input.serialNumber ? { serialNumber: input.serialNumber } : {}),
    ...(input.purchaseDate ? { purchaseDate: input.purchaseDate } : {}),
    ...(input.purchaseCost != null ? { purchaseCost: input.purchaseCost } : {}),
    ...(input.warrantyExpiry ? { warrantyExpiry: input.warrantyExpiry } : {}),
    ...(input.serviceIntervalDays != null
      ? { serviceIntervalDays: input.serviceIntervalDays }
      : {}),
    ...(input.nextServiceDue ? { nextServiceDue: input.nextServiceDue } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toAsset(doc.toObject() as AssetDoc);
}

export async function listAssets(filter: {
  status?: AssetStatus;
  category?: AssetCategory;
}): Promise<Asset[]> {
  const q: Record<string, unknown> = { ...scopeFilter() };
  if (filter.status) q.status = filter.status;
  if (filter.category) q.category = filter.category;
  const docs = await getAssetModel(getTenantDb()).find(q).sort({ assetTag: 1 }).lean<AssetDoc[]>();
  return docs.map(toAsset);
}

export async function findAssetById(id: string): Promise<Asset | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAssetModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<AssetDoc>();
  return doc ? toAsset(doc) : undefined;
}

export interface UpdateAssetInput {
  name?: string;
  category?: AssetCategory;
  status?: AssetStatus;
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  serviceIntervalDays?: number;
  nextServiceDue?: string;
}

export async function updateAsset(id: string, patch: UpdateAssetInput): Promise<Asset | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAssetModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<AssetDoc>();
  return doc ? toAsset(doc) : undefined;
}

/* ── Maintenance ─────────────────────────────────────────────────────────────── */

export interface AssetMaintenance {
  id: string;
  assetId: string;
  type: MaintenanceType;
  performedOn: string;
  performedBy?: string;
  cost?: number;
  notes?: string;
  nextServiceDue?: string;
  branchId?: string;
}

function toMaintenance(doc: AssetMaintenanceDoc): AssetMaintenance {
  return {
    id: doc._id.toString(),
    assetId: doc.assetId.toString(),
    type: doc.type,
    performedOn: doc.performedOn,
    ...(doc.performedBy ? { performedBy: doc.performedBy } : {}),
    ...(doc.cost != null ? { cost: doc.cost } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.nextServiceDue ? { nextServiceDue: doc.nextServiceDue } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateMaintenanceInput {
  assetId: string;
  type: MaintenanceType;
  performedOn: string;
  performedBy?: string;
  cost?: number;
  notes?: string;
  nextServiceDue?: string;
}

/**
 * Records a maintenance and, in the SAME call, rolls its facts onto the asset: the asset's
 * `lastServicedOn` becomes this visit's date, and its `nextServiceDue` becomes the date this
 * visit committed to (when one was given). Two writes, not a transaction — the log is the source
 * of truth and the asset fields are a denormalized convenience; a rare crash between them leaves
 * the history correct and the summary re-derivable, never a phantom service.
 */
export async function addMaintenance(
  input: CreateMaintenanceInput,
  asset: Asset,
): Promise<AssetMaintenance> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getAssetMaintenanceModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    assetId: new Types.ObjectId(asset.id),
    type: input.type,
    performedOn: input.performedOn,
    ...(input.performedBy ? { performedBy: input.performedBy } : {}),
    ...(input.cost != null ? { cost: input.cost } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.nextServiceDue ? { nextServiceDue: input.nextServiceDue } : {}),
    ...(ctx.userId ? { loggedBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });

  const assetPatch: Record<string, unknown> = { lastServicedOn: input.performedOn };
  if (input.nextServiceDue) assetPatch.nextServiceDue = input.nextServiceDue;
  await getAssetModel(getTenantDb()).updateOne(
    { _id: new Types.ObjectId(asset.id), ...scopeFilter() },
    { $set: assetPatch },
  );

  return toMaintenance(doc.toObject() as AssetMaintenanceDoc);
}

/** An asset's maintenance history, most recent first. */
export async function listMaintenance(assetId: string): Promise<AssetMaintenance[]> {
  if (!Types.ObjectId.isValid(assetId)) return [];
  const docs = await getAssetMaintenanceModel(getTenantDb())
    .find({ assetId: new Types.ObjectId(assetId), ...scopeFilter() })
    .sort({ performedOn: -1 })
    .lean<AssetMaintenanceDoc[]>();
  return docs.map(toMaintenance);
}
