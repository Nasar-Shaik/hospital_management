/**
 * RBAC repository — the only code that queries `roles` / `userRoles`.
 */
import { getRoleModel, getUserRoleModel, type RoleDoc } from "./rbac.model.js";
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

export async function findRoleByCode(code: string): Promise<Role | undefined> {
  const doc = await getRoleModel(getTenantDb()).findOne({ code: code.toUpperCase() });
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

export interface RoleBinding {
  roleId: string;
  roleCode: string;
  branchIds: string[];
}

/**
 * All role bindings for a user, joined to role codes.
 *
 * This runs on every login and every refresh, so it is a single indexed query
 * plus one `$in` — not a per-role round trip (PERFORMANCE_BUDGET).
 */
export async function findBindingsForUser(userId: string): Promise<RoleBinding[]> {
  const db = getTenantDb();
  const bindings = await getUserRoleModel(db).find({ userId });
  if (bindings.length === 0) return [];

  const roles = await getRoleModel(db).find({
    _id: { $in: bindings.map((b) => b.roleId) },
  });
  const codeById = new Map(roles.map((r) => [r._id.toString(), r.code]));

  return bindings.flatMap((b) => {
    const roleCode = codeById.get(b.roleId);
    // A binding whose role was deleted grants nothing — it must not become a
    // token claim of `undefined`.
    return roleCode ? [{ roleId: b.roleId, roleCode, branchIds: b.branchIds }] : [];
  });
}

/** Idempotent: re-assigning the same role to the same user updates its branch scope. */
export async function assignRole(
  userId: string,
  roleId: string,
  branchIds: string[] = [],
): Promise<void> {
  await getUserRoleModel(getTenantDb()).findOneAndUpdate(
    { userId, roleId },
    { userId, roleId, branchIds },
    { upsert: true },
  );
}

export async function revokeRole(userId: string, roleId: string): Promise<void> {
  await getUserRoleModel(getTenantDb()).deleteOne({ userId, roleId });
}
