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

/* ── permissions (the tenant's copy of the code-defined catalog) ─────────── */

export interface PermissionDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** `resource:action` — matches a code in `@medicore/permissions`. Immutable. */
  code: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const permissionSchema = new Schema<PermissionDoc>(
  {
    code: { type: String, required: true },
    resource: { type: String, required: true },
    action: { type: String, required: true },
    scope: { type: String, required: true, default: "tenant" },
    description: { type: String, required: true },
  },
  { timestamps: true, collection: "permissions", autoIndex: false },
);
permissionSchema.plugin(tenantScopePlugin);

/* ── rolePermissions (the grant) ─────────────────────────────────────────── */

export interface RolePermissionDoc {
  _id: Types.ObjectId;
  tenantId: string;
  roleId: string;
  permissionId: string;
  /**
   * Denormalized copy of the permission's code.
   *
   * Safe because codes are immutable by rule (see @medicore/permissions), and it
   * turns the hottest query in the system — "what may this user do?" — from three
   * round trips into two. Authorization runs on every single request; a join we
   * can avoid, we avoid.
   */
  permissionCode: string;
  createdAt: Date;
  updatedAt: Date;
}

const rolePermissionSchema = new Schema<RolePermissionDoc>(
  {
    roleId: { type: String, required: true },
    permissionId: { type: String, required: true },
    permissionCode: { type: String, required: true },
  },
  { timestamps: true, collection: "rolePermissions", autoIndex: false },
);
rolePermissionSchema.plugin(tenantScopePlugin);

export function getRoleModel(conn: Connection): Model<RoleDoc> {
  return (conn.models.Role as Model<RoleDoc>) ?? conn.model<RoleDoc>("Role", roleSchema);
}

export function getUserRoleModel(conn: Connection): Model<UserRoleDoc> {
  return (
    (conn.models.UserRole as Model<UserRoleDoc>) ??
    conn.model<UserRoleDoc>("UserRole", userRoleSchema)
  );
}

export function getPermissionModel(conn: Connection): Model<PermissionDoc> {
  return (
    (conn.models.Permission as Model<PermissionDoc>) ??
    conn.model<PermissionDoc>("Permission", permissionSchema)
  );
}

export function getRolePermissionModel(conn: Connection): Model<RolePermissionDoc> {
  return (
    (conn.models.RolePermission as Model<RolePermissionDoc>) ??
    conn.model<RolePermissionDoc>("RolePermission", rolePermissionSchema)
  );
}
