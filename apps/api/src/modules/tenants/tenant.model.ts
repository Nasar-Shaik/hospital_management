/**
 * Tenant registry model — lives in the MASTER database (Doc 03 §1.1).
 * Platform module: business modules never touch this (Doc 04 §2.2.1).
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import {
  ORGANIZATION_TYPES,
  type EncounterPolicy,
  type OrganizationType,
} from "@medicore/permissions";
import { getMasterConnection } from "../../core/db/masterDb.js";

/** Tenant lifecycle — STATE_MACHINE_CATALOG §11. Transitions are guarded in the service. */
export const TENANT_STATUSES = [
  "provisioning",
  "trial",
  "active",
  "suspended",
  "expired",
  "terminated",
  "exported",
  "purged",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Statuses whose requests are allowed to reach the application (Doc 04 §2.2.1 step 3). */
export const SERVABLE_TENANT_STATUSES: readonly TenantStatus[] = ["active", "trial"];

export interface TenantSubscription {
  planId?: Types.ObjectId;
  /** Edition code from Doc 07 (e.g. PLAN_CLINIC). */
  planCode?: string;
  status?: string;
  seats?: number;
}

/**
 * Platform-set limits for this hospital (ADR-0015). A limit is a SALES control, set by the
 * super-admin at provisioning — the tenant admin cannot raise it. It lives on the master record,
 * not in the tenant DB, for the same reason the plan does: a hospital must not be able to edit what
 * it is allowed to buy.
 */
export interface TenantLimits {
  /** How many branches this tenant may create. Default 1 — a single-site hospital. */
  maxBranches?: number;
}

export interface TenantDoc {
  _id: Types.ObjectId;
  hospitalName: string;
  slug: string;
  databaseName: string;
  /** Optional dedicated server/cluster override (Doc 03 §1.5) — placement tier change, no code change. */
  dbUri?: string;
  customDomain?: string;
  subscription: TenantSubscription;
  limits?: TenantLimits;
  status: TenantStatus;
  region?: string;
  /**
   * What KIND of hospital this is (ADR-0013 §6). It selects a policy preset at
   * provisioning and is descriptive from then on.
   *
   * Nothing may branch on it. `if (organizationType === "government_hospital")` is
   * forbidden — code asks the POLICY, never the type (see @medicore/permissions
   * organizations.ts). Government hospitals run paid private wards; the branch is
   * not even true, and it would make that customer unsellable.
   */
  organizationType?: OrganizationType;
  /**
   * The deliberate deviations this hospital has made from its preset.
   *
   * ONLY the overrides are stored — never a snapshot of the preset. A copied preset
   * drifts: improve the government default next year and every hospital provisioned
   * before it silently keeps the old one. Effective policy is resolved at read time
   * (`resolveEncounterPolicy`), so we can improve defaults AND honour every choice a
   * hospital has actually made.
   */
  encounterPolicy?: Partial<EncounterPolicy>;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new Schema<TenantDoc>(
  {
    hospitalName: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    databaseName: { type: String, required: true, unique: true },
    dbUri: { type: String },
    customDomain: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    subscription: {
      planId: { type: Schema.Types.ObjectId },
      planCode: { type: String },
      status: { type: String },
      seats: { type: Number },
    },
    limits: {
      maxBranches: { type: Number, min: 1 },
    },
    status: { type: String, enum: TENANT_STATUSES, required: true, default: "provisioning" },
    region: { type: String },
    organizationType: { type: String, enum: ORGANIZATION_TYPES },
    // Free-form on purpose: it is a Partial<EncounterPolicy>, and the enum for each
    // field is enforced where it is resolved, not smeared across the schema.
    encounterPolicy: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: "tenants" },
);

// Resolution paths must be indexed — they run on every request (PERFORMANCE_BUDGET: p95 15ms).
tenantSchema.index({ status: 1 });

export async function getTenantModel(): Promise<Model<TenantDoc>> {
  const conn: Connection = await getMasterConnection();
  return (conn.models.Tenant as Model<TenantDoc>) ?? conn.model<TenantDoc>("Tenant", tenantSchema);
}
