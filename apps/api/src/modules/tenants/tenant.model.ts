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

/** Licence lifecycle (ADR-0016) — INDEPENDENT of `TenantStatus` (operator suspend). */
export const LICENSE_STATUSES = ["TRIAL", "ACTIVE", "EXPIRED", "CANCELLED"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/**
 * Per-tenant licence (tenure) — ADR-0016. A validity window (`validFrom → expiresAt`,
 * to the second) plus a grace window (`graceDays` after expiry, during which the
 * hospital still runs but sees a renewal banner). Past grace the request gate blocks it.
 *
 * DISTINCT from `subscription.planCode` (the edition, which decides FEATURES): the
 * licence decides UNTIL WHEN. A hospital on the Hospital edition whose licence lapsed
 * for non-payment is blocked without changing what it bought — raise the expiry and it
 * returns exactly as it was. Lives on the master record, never in the tenant DB: a
 * hospital must not be able to edit its own expiry.
 *
 * No `expiresAt` = perpetual (never expires) — the deliberate shape for an internal or
 * flagship account the operator does not want to churn.
 */
export interface TenantLicense {
  /** Free-form commercial label (TRIAL/STANDARD/PREMIUM…). Not the edition. */
  plan?: string;
  status?: LicenseStatus;
  validFrom?: Date;
  /** Absent ⇒ perpetual. Present ⇒ enforced to the second at the request gate. */
  expiresAt?: Date;
  graceDays?: number;
  lastRenewedAt?: Date;
  notes?: string;
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
  /** Tenure (ADR-0016). Absent on hospitals provisioned before licensing existed ⇒ perpetual. */
  license?: TenantLicense;
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
    license: {
      plan: { type: String, trim: true },
      status: { type: String, enum: LICENSE_STATUSES },
      validFrom: { type: Date },
      expiresAt: { type: Date },
      graceDays: { type: Number, min: 0 },
      lastRenewedAt: { type: Date },
      notes: { type: String, default: "" },
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
