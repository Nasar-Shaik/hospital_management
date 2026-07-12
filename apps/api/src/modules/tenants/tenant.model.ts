/**
 * Tenant registry model — lives in the MASTER database (Doc 03 §1.1).
 * Platform module: business modules never touch this (Doc 04 §2.2.1).
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
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

export interface TenantDoc {
  _id: Types.ObjectId;
  hospitalName: string;
  slug: string;
  databaseName: string;
  /** Optional dedicated server/cluster override (Doc 03 §1.5) — placement tier change, no code change. */
  dbUri?: string;
  customDomain?: string;
  subscription: TenantSubscription;
  status: TenantStatus;
  region?: string;
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
    status: { type: String, enum: TENANT_STATUSES, required: true, default: "provisioning" },
    region: { type: String },
  },
  { timestamps: true, collection: "tenants" },
);

// Resolution paths must be indexed — they run on every request (PERFORMANCE_BUDGET: p95 15ms).
tenantSchema.index({ status: 1 });

export async function getTenantModel(): Promise<Model<TenantDoc>> {
  const conn: Connection = await getMasterConnection();
  return (conn.models.Tenant as Model<TenantDoc>) ?? conn.model<TenantDoc>("Tenant", tenantSchema);
}
