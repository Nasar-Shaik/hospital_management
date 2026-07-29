/**
 * Asset + maintenance service — the estate register (Module B7).
 *
 * Thin over the repository: it turns a duplicate asset tag into the hospital's own sentence,
 * refuses a maintenance against an unknown (or out-of-scope) asset, and forbids logging work on
 * an asset that has been retired — a decommissioned machine does not get serviced.
 */
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./asset.repository.js";

export type { Asset, AssetMaintenance } from "./asset.repository.js";

export const listAssets = repo.listAssets;
export const getAsset = repo.findAssetById;
export const listMaintenance = repo.listMaintenance;

export async function createAsset(input: repo.CreateAssetInput): Promise<repo.Asset> {
  try {
    return await repo.createAsset(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That asset tag already exists", {
        assetTag: input.assetTag,
        hint: "asset tags are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateAsset(id: string, patch: repo.UpdateAssetInput): Promise<repo.Asset> {
  const existing = await repo.findAssetById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Asset not found", { id });
  const updated = await repo.updateAsset(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Asset not found", { id });
  return updated;
}

export async function addMaintenance(
  assetId: string,
  input: Omit<repo.CreateMaintenanceInput, "assetId">,
): Promise<repo.AssetMaintenance> {
  const asset = await repo.findAssetById(assetId);
  if (!asset) throw new AppError("HMS-GEN-404", 404, "Asset not found", { id: assetId });

  // A retired asset is decommissioned — logging a service on it would resurrect a dead record on
  // the register and quietly reset its "next due" date. Bring it back with an explicit status
  // change first if it is genuinely returning to use.
  if (asset.status === "retired") {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      assetId,
      reason: "this asset is retired; reactivate it before logging maintenance",
    });
  }

  return repo.addMaintenance({ ...input, assetId }, asset);
}
