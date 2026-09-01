/**
 * RBAC repository — the only code that queries `roles`, `userRoles`,
 * `permissions` and `rolePermissions`.
 */
import type { PermissionDefinition } from "@medicore/permissions";
import {
  getPermissionModel,
  getRoleModel,
  getRolePermissionModel,
  getUserRoleModel,
  type BranchScope,
  type RoleDoc,
} from "./rbac.model.js";
import { getTenantDb } from "../../core/context/requestContext.js";

export interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  description?: string;
}

function toRole(doc: RoleDoc): Role {
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    isSystem: doc.isSystem,
    ...(doc.description ? { description: doc.description } : {}),
  };
}

/* ── roles ───────────────────────────────────────────────────────────────── */

export async function findRoleByCode(code: string): Promise<Role | undefined> {
  const doc = await getRoleModel(getTenantDb()).findOne({ code: code.toUpperCase() });
  return doc ? toRole(doc) : undefined;
}

export async function findRoleById(roleId: string): Promise<Role | undefined> {
  const doc = await getRoleModel(getTenantDb()).findById(roleId);
  return doc ? toRole(doc) : undefined;
}

export async function listRoles(): Promise<Role[]> {
  const docs = await getRoleModel(getTenantDb()).find().sort({ code: 1 });
  return docs.map(toRole);
}

export async function upsertRole(input: {
  code: string;
  name: string;
  description?: string;
  isSystem: boolean;
}): Promise<Role> {
  const doc = await getRoleModel(getTenantDb()).findOneAndUpdate(
    { code: input.code.toUpperCase() },
    { $setOnInsert: { ...input, code: input.code.toUpperCase() } },
    { new: true, upsert: true },
  );
  return toRole(doc);
}

export async function createRole(input: {
  code: string;
  name: string;
  description?: string;
}): Promise<Role> {
  const doc = await getRoleModel(getTenantDb()).create({ ...input, isSystem: false });
  return toRole(doc);
}

export async function deleteRole(roleId: string): Promise<void> {
  const db = getTenantDb();
  await getRoleModel(db).deleteOne({ _id: roleId });
  await getRolePermissionModel(db).deleteMany({ roleId });
  await getUserRoleModel(db).deleteMany({ roleId });
}

/* ── permission catalog ──────────────────────────────────────────────────── */

export interface Permission {
  id: string;
  code: string;
  resource: string;
  action: string;
  scope: string;
  description: string;
}

export async function listPermissions(): Promise<Permission[]> {
  const docs = await getPermissionModel(getTenantDb()).find().sort({ code: 1 });
  return docs.map((d) => ({
    id: d._id.toString(),
    code: d.code,
    resource: d.resource,
    action: d.action,
    scope: d.scope,
    description: d.description,
  }));
}

/**
 * Syncs the code-defined catalog into this tenant's database.
 *
 * Additive only — it never deletes. A permission removed from the code catalog
 * stays in the database as an orphan rather than silently revoking access from
 * roles that hold it. Removal is a deliberate migration, not a side effect of a
 * deploy.
 */
export async function syncPermissionCatalog(definitions: PermissionDefinition[]): Promise<number> {
  const model = getPermissionModel(getTenantDb());
  const existing = new Set((await model.find({}, { code: 1 })).map((d) => d.code));

  const missing = definitions.filter((d) => !existing.has(d.code));
  if (missing.length > 0) {
    await model.insertMany(
      missing.map((d) => ({
        code: d.code,
        resource: d.resource,
        action: d.action,
        scope: d.scope ?? "tenant",
        description: d.description,
      })),
    );
  }
  return missing.length;
}

/* ── role → permission grants ────────────────────────────────────────────── */

export async function setRolePermissions(roleId: string, codes: string[]): Promise<void> {
  const db = getTenantDb();
  const permissions = await getPermissionModel(db).find({ code: { $in: codes } });
  const model = getRolePermissionModel(db);

  // Replace wholesale: the caller states the full desired set, so a permission
  // absent from `codes` must be revoked, not merely "not added".
  await model.deleteMany({ roleId });
  if (permissions.length > 0) {
    await model.insertMany(
      permissions.map((permission) => ({
        roleId,
        permissionId: permission._id.toString(),
        permissionCode: permission.code,
      })),
    );
  }
}

export async function findPermissionCodesForRole(roleId: string): Promise<string[]> {
  const docs = await getRolePermissionModel(getTenantDb()).find({ roleId });
  return docs.map((d) => d.permissionCode);
}

/* ── user bindings ───────────────────────────────────────────────────────── */

export interface RoleBinding {
  roleId: string;
  roleCode: string;
  branchScope: BranchScope;
  branchIds: string[];
}

/**
 * Users whose bindings ALL point somewhere other than this branch.
 *
 * ── WHY THE EXCLUSION AND NOT THE INCLUSION ─────────────────────────────────
 * The staff directory has no `branchId` of its own — a person belongs to the hospital, and where
 * they work is a property of their ROLE BINDING (ADR-0015: "one staff directory"). So scoping the
 * directory to a branch cannot be a `scopeFilter()` on the user document; it has to come from here.
 *
 * Returning who to HIDE rather than who to show matters twice over:
 *
 *   1. It is the short list. Most staff in a real hospital are hospital-wide (`branchScope: "all"`)
 *      and stay visible everywhere, so the exclusion set is only the staff confined to OTHER sites.
 *      The inclusion set would be nearly the whole directory, re-sent on every page.
 *   2. A user with NO binding at all is not in it, so they stay visible. That is deliberate: an
 *      account created but not yet given a role belongs to no branch, and hiding it from every
 *      branch view would make it unfindable by the person who has to assign the role. Invisible is
 *      worse than misfiled — this is the safer horn of the same dilemma D11 records for un-stamped
 *      clinical rows.
 *
 * `branchScope` is the authority, not the emptiness of `branchIds`: `"branches"` with an empty list
 * means NOWHERE, deliberately, and this must not silently read it as "everywhere".
 */
export async function userIdsOutsideBranch(branchId: string): Promise<string[]> {
  const model = getUserRoleModel(getTenantDb());

  const [bound, reaching] = await Promise.all([
    model.distinct("userId", {}),
    model.distinct("userId", {
      $or: [{ branchScope: "all" }, { branchScope: "branches", branchIds: branchId }],
    }),
  ]);

  const visible = new Set(reaching);
  return bound.filter((id) => !visible.has(id));
}

export async function findBindingsForUser(userId: string): Promise<RoleBinding[]> {
  const db = getTenantDb();
  const bindings = await getUserRoleModel(db).find({ userId });
  if (bindings.length === 0) return [];

  const roles = await getRoleModel(db).find({ _id: { $in: bindings.map((b) => b.roleId) } });
  const codeById = new Map(roles.map((r) => [r._id.toString(), r.code]));

  return bindings.flatMap((b) => {
    const roleCode = codeById.get(b.roleId);
    // A binding whose role was deleted grants nothing.
    return roleCode
      ? [{ roleId: b.roleId, roleCode, branchScope: b.branchScope, branchIds: b.branchIds }]
      : [];
  });
}

/**
 * The hot query: every permission code this user holds, via any role.
 *
 * Two round trips, not three — `rolePermissions` carries the code (see the model).
 * Runs on every authorized request when the cache is cold.
 */
export async function findPermissionCodesForUser(userId: string): Promise<string[]> {
  const db = getTenantDb();
  const bindings = await getUserRoleModel(db).find({ userId }, { roleId: 1 });
  if (bindings.length === 0) return [];

  const grants = await getRolePermissionModel(db).find(
    { roleId: { $in: bindings.map((b) => b.roleId) } },
    { permissionCode: 1 },
  );
  return [...new Set(grants.map((g) => g.permissionCode))];
}

/**
 * Binds a role to a user.
 *
 * The caller's INTENT is read from whether they named any branches — naming some
 * means "restrict to these", naming none means "the whole hospital" — and then it
 * is STORED, so nothing downstream has to re-derive it from an array that a later
 * bug could empty. That is the whole point of `branchScope` (see rbac.model.ts).
 */
export async function assignRole(
  userId: string,
  roleId: string,
  branchIds: string[] = [],
): Promise<void> {
  const branchScope: BranchScope = branchIds.length > 0 ? "branches" : "all";

  await getUserRoleModel(getTenantDb()).findOneAndUpdate(
    { userId, roleId },
    { userId, roleId, branchScope, branchIds },
    { upsert: true },
  );
}

export async function revokeRole(userId: string, roleId: string): Promise<void> {
  await getUserRoleModel(getTenantDb()).deleteOne({ userId, roleId });
}

/** Every user holding a role — needed to invalidate their cached permissions when the role changes. */
export async function findUserIdsWithRole(roleId: string): Promise<string[]> {
  const docs = await getUserRoleModel(getTenantDb()).find({ roleId }, { userId: 1 });
  return docs.map((d) => d.userId);
}
