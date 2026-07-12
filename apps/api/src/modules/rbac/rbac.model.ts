/**
 * RBAC storage (tenant DB `roles`, `userRoles` — Doc 03 §2, ADR-0010).
 *
 * SCOPE OF PHASE 1B: roles and the user→role binding, because ADR-0009 requires
 * the access token to carry `roles` and `branchIds`. The permission catalog
 * (`permissions`, `rolePermissions`) and the `authorize` middleware are Phase 1C
 * — they extend this module; they do not replace it.
 *
 * Depends on `users` only through a userId string, never an import — see
 * user.model.ts for why the graph is shaped this way.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";

export interface RoleDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Stable machine identifier referenced by code and by the token (`TENANT_ADMIN`). */
  code: string;
  name: string;
  description?: string;
  /**
   * System roles are seeded at provisioning and may not be deleted or renamed —
   * a tenant that deletes its own admin role locks itself out permanently.
   */
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDoc>(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "roles", autoIndex: false },
);
roleSchema.plugin(tenantScopePlugin);

export interface UserRoleDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  roleId: string;
  /**
   * Branch scoping (Doc 03 §1): empty means "all branches this role can reach".
   * Row-level scope enforcement arrives with the authorize middleware in 1C.
   */
  branchIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const userRoleSchema = new Schema<UserRoleDoc>(
  {
    userId: { type: String, required: true },
    roleId: { type: String, required: true },
    branchIds: { type: [String], default: [] },
  },
  { timestamps: true, collection: "userRoles", autoIndex: false },
);
userRoleSchema.plugin(tenantScopePlugin);

export function getRoleModel(conn: Connection): Model<RoleDoc> {
  return (conn.models.Role as Model<RoleDoc>) ?? conn.model<RoleDoc>("Role", roleSchema);
}

export function getUserRoleModel(conn: Connection): Model<UserRoleDoc> {
  return (
    (conn.models.UserRole as Model<UserRoleDoc>) ??
    conn.model<UserRoleDoc>("UserRole", userRoleSchema)
  );
}

/**
 * System roles seeded into every new tenant database (provisioning, Doc 04 §7).
 *
 * Deliberately minimal: TENANT_ADMIN is what a hospital needs to log in and
 * configure itself on day one. The full clinical role set (DOCTOR, NURSE,
 * RECEPTIONIST, PHARMACIST, LAB_TECH, …) is seeded in Phase 1C alongside the
 * permission catalog that gives those roles meaning — seeding named roles with
 * no permissions attached would be a lie in the database.
 */
export const SYSTEM_ROLES = [
  {
    code: "TENANT_ADMIN",
    name: "Administrator",
    description: "Full administrative access to this hospital's configuration and users.",
  },
] as const;
