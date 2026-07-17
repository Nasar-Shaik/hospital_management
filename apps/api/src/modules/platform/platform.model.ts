/**
 * Platform users — US, the operators (master DB `platformUsers`).
 *
 * ── WHY THEY CANNOT LIVE IN A TENANT DATABASE ────────────────────────────────
 * A super-admin acts ACROSS hospitals. Put them in `hms_demo` and they belong to
 * one hospital while needing authority over all of them — an identity that is
 * simultaneously inside and outside the tenancy boundary. That boundary is the
 * single most important property this system has (ADR-0005), and the way you
 * destroy it is by creating one user who lives on both sides.
 *
 * So platform identity is a SEPARATE population, in the master database, with a
 * separate login on a separate hostname (`admin.<domain>`), and a token that is
 * rejected by every tenant route. A hospital user's token is likewise rejected
 * here. The two identity systems share code and share nothing else.
 *
 * ── WHAT AN OPERATOR IS DELIBERATELY NOT ALLOWED TO DO ───────────────────────
 * Read patient records. There is no route in the platform surface that returns
 * PHI, and there never should be. "The vendor can read all your patients" fails
 * HIPAA minimum-necessary, loses hospital deals, and turns our support team into
 * the largest breach surface on the platform.
 *
 * Support work that genuinely needs to see a hospital's screen goes through
 * IMPERSONATION — which issues an ordinary tenant token, subject to that
 * hospital's own permissions, and writes an entry into THAT HOSPITAL'S audit
 * trail. The customer's compliance officer can see us looking. That asymmetry is
 * the point: they watch us, not just us watching them.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";

/** Operator roles. Deliberately few — this population should stay small. */
export const PLATFORM_ROLES = [
  /** Everything: provision, suspend, change plans, impersonate. */
  "SUPER_ADMIN",
  /**
   * Read-only over the fleet: can see hospitals, plans and usage, and can
   * impersonate for support — but cannot provision, suspend or re-price.
   * Most operator work is support work; most operators should be this.
   */
  "SUPPORT",
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_USER_STATUSES = ["active", "disabled"] as const;
export type PlatformUserStatus = (typeof PLATFORM_USER_STATUSES)[number];

export interface PlatformUserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  /** argon2id, same as tenant credentials (core/crypto/password). */
  passwordHash: string;
  roles: PlatformRole[];
  status: PlatformUserStatus;
  /**
   * MFA is not optional for an operator in production — an account here can
   * reach every hospital on the platform. Enforcement lands with the MFA wiring;
   * the field exists now so the requirement is recorded rather than remembered.
   */
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const platformUserSchema = new Schema<PlatformUserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    roles: { type: [String], enum: PLATFORM_ROLES, required: true, default: undefined },
    status: { type: String, enum: PLATFORM_USER_STATUSES, required: true, default: "active" },
    mfaEnabled: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
  },
  // NOT tenant-scoped: no tenantScopePlugin, no auditPlugin. Those plugins require
  // a tenant context, and this collection exists precisely because there isn't one.
  { timestamps: true, collection: "platformUsers" },
);

export function getPlatformUserModel(conn: Connection): Model<PlatformUserDoc> {
  return (
    (conn.models.PlatformUser as Model<PlatformUserDoc>) ??
    conn.model<PlatformUserDoc>("PlatformUser", platformUserSchema)
  );
}

/* ── the operator's own audit trail (master DB) ────────────────────────────────
 *
 * Actions that touch a HOSPITAL are audited in that hospital's trail, where its
 * compliance officer can see them. But an operator logging in, or being created,
 * or being disabled, belongs to no hospital — and those events must still be
 * recorded somewhere, or the control plane is the one unaudited surface on the
 * platform.
 */

export interface PlatformAuditDoc {
  _id: Types.ObjectId;
  at: Date;
  actorId?: string;
  actorEmail?: string;
  action: string;
  /** The hospital this concerned, when it concerned one. */
  tenantSlug?: string;
  outcome: "success" | "failure";
  meta?: Record<string, unknown>;
  ip?: string;
  traceId?: string;
}

const platformAuditSchema = new Schema<PlatformAuditDoc>(
  {
    at: { type: Date, required: true },
    actorId: { type: String },
    actorEmail: { type: String },
    action: { type: String, required: true },
    tenantSlug: { type: String },
    outcome: { type: String, enum: ["success", "failure"], required: true, default: "success" },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
    traceId: { type: String },
  },
  { timestamps: false, collection: "platformAuditLogs" },
);

export function getPlatformAuditModel(conn: Connection): Model<PlatformAuditDoc> {
  return (
    (conn.models.PlatformAudit as Model<PlatformAuditDoc>) ??
    conn.model<PlatformAuditDoc>("PlatformAudit", platformAuditSchema)
  );
}
