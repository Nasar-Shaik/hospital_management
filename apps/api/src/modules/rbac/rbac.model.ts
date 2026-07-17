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

/**
 * Is this binding restricted to particular branches, or does it reach the whole
 * hospital? (ADR-0010 layer 3.)
 *
 * ── WHY THIS FIELD EXISTS AT ALL ─────────────────────────────────────────────
 * It replaces an EMPTY `branchIds` array as the carrier of that meaning, and it
 * was added the day the first branch-scoped resource shipped (patients, P2),
 * because the empty array had quietly come to mean two opposite things:
 *
 *     rbac.model     "empty means all branches this role can reach"
 *     rbac.service   "Empty = not restricted to specific branches"
 *     authorize      "$in: []  →  Fail closed. Allowed NOWHERE."
 *
 * Both readings are defensible, which is precisely why `[]` must not be the thing
 * that decides. Nothing exercised the contradiction while every resource was
 * tenant-scoped; the first `branch`-scoped collection made the whole patient list
 * empty for every user in the hospital, including the administrator who had just
 * registered them.
 *
 * ── AND WHY IT IS NOT SIMPLY "[] MEANS EVERYWHERE" ───────────────────────────
 * Because that is the failure the fail-closed rule was written to prevent, and it
 * remains right: if a bug, a bad migration or a careless edit ever CLEARS the
 * branch list on a restricted binding, "empty = everywhere" silently promotes a
 * ward nurse to the whole hospital. With the intent stored explicitly, that same
 * accident leaves `branchScope: "branches"` with no branches — and grants nothing,
 * loudly. Unrestricted access now requires a value somebody deliberately set.
 */
export const BRANCH_SCOPES = ["all", "branches"] as const;
export type BranchScope = (typeof BRANCH_SCOPES)[number];

export interface UserRoleDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  roleId: string;
  /** `all` → the whole hospital. `branches` → only `branchIds` (empty = nowhere). */
  branchScope: BranchScope;
  /** Meaningful only when `branchScope === "branches"`. */
  branchIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const userRoleSchema = new Schema<UserRoleDoc>(
  {
    userId: { type: String, required: true },
    roleId: { type: String, required: true },
    branchScope: { type: String, enum: BRANCH_SCOPES, required: true, default: "all" },
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
