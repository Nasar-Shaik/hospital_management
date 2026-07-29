/**
 * Asset register + maintenance log (Module B7, Doc 02 B-group facility).
 *
 * ── WHAT B7 IS ──────────────────────────────────────────────────────────────
 * The equipment a hospital OWNS and must keep serviceable — a ventilator, an X-ray, a
 * generator, a fleet of wheelchairs — and the history of every service done on each. It is a
 * REGISTER (what we have, where, in what state) plus a LOG (what was done, when, by whom). It is
 * NOT the bed inventory (B4) and not the ambulance fleet (B6); those are places a patient goes,
 * this is the estate that has to work for them.
 *
 * ── WHY THE NEXT-SERVICE DATE LIVES ON THE ASSET, NOT DERIVED ────────────────
 * "When is this due for service?" is answered by a single stored `nextServiceDue`, set when a
 * maintenance is logged (or by hand). It is deliberately NOT derived from `lastServiced +
 * interval` on read: a service can be brought forward after a fault, or pushed back, and the
 * planner's date must be the one a human last committed to — not a formula that silently moves it.
 * The board flags an asset as due by comparing that stored date to today.
 *
 * Money (`purchaseCost`, maintenance `cost`) is stored in PAISE — integer minor units — like every
 * amount in the system, so it never disagrees with billing about what a rupee is.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** The kind of asset — groups the register and hints the service regime; drives nothing in code. */
export const ASSET_CATEGORIES = [
  "biomedical",
  "imaging",
  "it_equipment",
  "furniture",
  "vehicle",
  "hvac",
  "electrical",
  "other",
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/**
 * The asset's working state.
 * - `in_service`        — usable.
 * - `under_maintenance` — down for service/repair; not usable right now.
 * - `retired`           — decommissioned; kept for its history, never "in service" again.
 */
export const ASSET_STATUSES = ["in_service", "under_maintenance", "retired"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface AssetDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** Short code, unique per tenant — the human key on the register (`AST-001`, `VENT-3`). */
  assetTag: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;

  /** Free-text placement — a ward, room or department label. Not a bed reference. */
  location?: string;
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;

  /** `YYYY-MM-DD`, local reckoning — a whole-day fact, no timezone (mirrors doctor leave). */
  purchaseDate?: string;
  /** Purchase price in PAISE. */
  purchaseCost?: number;
  warrantyExpiry?: string;

  /** Preventive-maintenance cycle in days, when the asset has one — informational + a default. */
  serviceIntervalDays?: number;
  /** The date the asset is next due for service — the planner's committed date (see header). */
  nextServiceDue?: string;
  /** The date of the most recent logged maintenance — denormalized for the register. */
  lastServicedOn?: string;

  notes?: string;

  createdAt: Date;
  updatedAt: Date;
}

/** The kind of work done — groups the history and hints why the asset was down. */
export const MAINTENANCE_TYPES = ["preventive", "repair", "inspection", "calibration"] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export interface AssetMaintenanceDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  assetId: Types.ObjectId;
  type: MaintenanceType;
  /** `YYYY-MM-DD` — the day the work was done. */
  performedOn: string;
  /** Who did it — an in-house engineer or an external vendor. Free text, optional. */
  performedBy?: string;
  /** Cost of this service in PAISE. */
  cost?: number;
  notes?: string;
  /** The next service date this visit commits to — copied onto the asset when set. */
  nextServiceDue?: string;

  loggedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const assetSchema = new Schema<AssetDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    assetTag: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, enum: ASSET_CATEGORIES, required: true, default: "other" },
    status: { type: String, enum: ASSET_STATUSES, required: true, default: "in_service" },

    location: { type: String, trim: true, maxlength: 120 },
    manufacturer: { type: String, trim: true, maxlength: 120 },
    modelNumber: { type: String, trim: true, maxlength: 80 },
    serialNumber: { type: String, trim: true, maxlength: 80 },

    purchaseDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    purchaseCost: { type: Number, min: 0 },
    warrantyExpiry: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

    serviceIntervalDays: { type: Number, min: 1, max: 3650 },
    nextServiceDue: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    lastServicedOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

    notes: { type: String, trim: true, maxlength: 1000 },
  },
  // Indexes owned by migration 0036, never autoIndex — see the patient model.
  { timestamps: true, collection: "assets", autoIndex: false },
);

const assetMaintenanceSchema = new Schema<AssetMaintenanceDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    assetId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: MAINTENANCE_TYPES, required: true, default: "preventive" },
    performedOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    performedBy: { type: String, trim: true, maxlength: 120 },
    cost: { type: Number, min: 0 },
    notes: { type: String, trim: true, maxlength: 1000 },
    nextServiceDue: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

    loggedBy: { type: String },
  },
  { timestamps: true, collection: "assetMaintenance", autoIndex: false },
);

assetSchema.plugin(tenantScopePlugin);
assetMaintenanceSchema.plugin(tenantScopePlugin);

// Estate configuration — `admin`, like `wards` and `ambulances`. No PHI anywhere here.
assetSchema.plugin(auditPlugin, { resource: "asset", category: "admin" });
assetMaintenanceSchema.plugin(auditPlugin, { resource: "assetMaintenance", category: "admin" });

export function getAssetModel(conn: Connection): Model<AssetDoc> {
  return (conn.models.Asset as Model<AssetDoc>) ?? conn.model<AssetDoc>("Asset", assetSchema);
}

export function getAssetMaintenanceModel(conn: Connection): Model<AssetMaintenanceDoc> {
  return (
    (conn.models.AssetMaintenance as Model<AssetMaintenanceDoc>) ??
    conn.model<AssetMaintenanceDoc>("AssetMaintenance", assetMaintenanceSchema)
  );
}
