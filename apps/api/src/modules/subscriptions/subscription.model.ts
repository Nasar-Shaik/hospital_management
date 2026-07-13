/**
 * Plans and usage — MASTER database (Doc 03 §2, Doc 07).
 *
 * A plan is what a hospital BOUGHT: a named bundle of feature flags and limits.
 * It lives in the master registry, never in the hospital's own database — a
 * tenant must not be able to raise its own bed limit by editing its data.
 *
 * The catalog is code-defined (`@medicore/permissions` EDITIONS) and mirrored
 * here so the platform can price, list and (later) invoice against rows. Code is
 * the source of truth for what an edition *unlocks*; these rows are the source of
 * truth for what a customer *pays*.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { getMasterConnection } from "../../core/db/masterDb.js";

export interface PlanDoc {
  _id: Types.ObjectId;
  /** Matches an EDITIONS key (`PLAN_HOSPITAL`). Immutable. */
  code: string;
  name: string;
  /** Feature flags the edition unlocks. Mirrored from code at seed time. */
  entitlements: string[];
  limits: {
    maxUsers?: number;
    maxDoctors?: number;
    maxBranches?: number;
    maxBeds?: number;
    maxPatients?: number;
    storageGb?: number;
  };
  /** Integer minor units (Constitution §3.4) — never a float. */
  priceMinor?: number;
  currency?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<PlanDoc>(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    name: { type: String, required: true },
    entitlements: { type: [String], default: [] },
    limits: {
      maxUsers: { type: Number },
      maxDoctors: { type: Number },
      maxBranches: { type: Number },
      maxBeds: { type: Number },
      maxPatients: { type: Number },
      storageGb: { type: Number },
    },
    priceMinor: { type: Number },
    currency: { type: String, default: "INR" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "plans" },
);

export async function getPlanModel(): Promise<Model<PlanDoc>> {
  const conn: Connection = await getMasterConnection();
  return (conn.models.Plan as Model<PlanDoc>) ?? conn.model<PlanDoc>("Plan", planSchema);
}

/**
 * Metered usage (Doc 07 §Enforcement).
 *
 * A cache of counts, not the truth. The truth is the tenant's own data — you can
 * always recount. That matters: a counter that drifts must never be able to lock
 * a hospital out of registering a patient, so anything cheap to count is counted
 * live and this collection exists for the metrics that are not (storage, API
 * calls, and later patients at volume).
 */
export interface UsageCounterDoc {
  _id: Types.ObjectId;
  tenantId: string;
  metric: string;
  /** `YYYY-MM` for periodic metrics, or `total` for cumulative ones. */
  period: string;
  value: number;
  updatedAt: Date;
  createdAt: Date;
}

const usageCounterSchema = new Schema<UsageCounterDoc>(
  {
    tenantId: { type: String, required: true },
    metric: { type: String, required: true },
    period: { type: String, required: true, default: "total" },
    value: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: "usageCounters" },
);
usageCounterSchema.index({ tenantId: 1, metric: 1, period: 1 }, { unique: true });

export async function getUsageCounterModel(): Promise<Model<UsageCounterDoc>> {
  const conn: Connection = await getMasterConnection();
  return (
    (conn.models.UsageCounter as Model<UsageCounterDoc>) ??
    conn.model<UsageCounterDoc>("UsageCounter", usageCounterSchema)
  );
}
