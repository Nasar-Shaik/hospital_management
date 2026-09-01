/**
 * Assets module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B7).
 *
 * Owns the asset register and its maintenance log. A leaf: it depends on nothing operational and
 * nothing depends on it, so the graph stays acyclic. No PHI — this is estate configuration.
 */
export { assetRouter } from "./asset.routes.js";

export {
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  listMaintenance,
  addMaintenance,
  type Asset,
  type AssetMaintenance,
} from "./asset.service.js";

export {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  MAINTENANCE_TYPES,
  type AssetCategory,
  type AssetStatus,
  type MaintenanceType,
} from "./asset.model.js";
