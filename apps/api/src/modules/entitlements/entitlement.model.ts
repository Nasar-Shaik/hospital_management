/**
 * Feature-flag overrides — MASTER database (Doc 03 §2, `featureFlags`).
 *
 * Platform module: it answers "what did this hospital BUY?", which is a
 * commercial question, not a clinical one — so it lives in the master registry
 * alongside the subscription, not in the hospital's own database. A hospital
 * must not be able to switch on a module it hasn't paid for by editing its own
 * data.
 *
 * The plan (edition) is the baseline; rows here are per-tenant exceptions:
 * a trial add-on, a pilot, or a feature disabled for one customer.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { getMasterConnection } from "../../core/db/masterDb.js";

export interface FeatureFlagDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** A flag from `@medicore/permissions` FEATURE_FLAGS. */
  flag: string;
  enabled: boolean;
  /** Optional per-branch override; unset means the whole tenant. */
  branchId?: string;
  /** Why this exception exists — an override with no reason becomes folklore. */
  reason?: string;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<FeatureFlagDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    flag: { type: String, required: true },
    enabled: { type: Boolean, required: true },
    branchId: { type: String },
    reason: { type: String },
    expiresAt: { type: Date },
  },
  { timestamps: true, collection: "featureFlags" },
);

featureFlagSchema.index({ tenantId: 1, flag: 1 }, { unique: true });

export async function getFeatureFlagModel(): Promise<Model<FeatureFlagDoc>> {
  const conn: Connection = await getMasterConnection();
  return (
    (conn.models.FeatureFlag as Model<FeatureFlagDoc>) ??
    conn.model<FeatureFlagDoc>("FeatureFlag", featureFlagSchema)
  );
}
