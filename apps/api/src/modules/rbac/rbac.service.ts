/**
 * RBAC service (ADR-0010) — layer 2 of authorization: does this USER hold the
 * permission?
 *
 * ── THE CACHE, AND WHY IT FAILS THE WAY IT DOES ──────────────────────────────
 * Effective permissions are cached at `perm:{userId}` (CACHE_STRATEGY). Two
 * properties matter and they pull in opposite directions:
 *
 *   • A Redis outage must NOT grant access. Our cache helpers fail soft and
 *     return `undefined` on failure — which here means "cache miss", so we fall
 *     through to MongoDB and check properly. Degraded latency, identical answer.
 *     (This is the opposite of the token blocklist, which fails open on purpose;
 *     there, failing closed would lock a hospital out. Here, failing open would
 *     hand out permissions. Same infrastructure, opposite correct behaviour —
 *     which is exactly why each is spelled out rather than left to instinct.)
 *
 *   • A revoked role must stop working NOW, not in five minutes. So every write
 *     that changes what a user can do invalidates the cache in the SAME service
 *     method that made the change (CACHE_STRATEGY invalidation discipline) —
 *     never fire-and-forget from a controller.
 */
import { ALL_PERMISSIONS, DEFAULT_ROLES } from "@medicore/permissions";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/appError.js";
import { recordAudit } from "../../core/audit/auditWriter.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { cacheDel, cacheGet, cacheKeys, cacheSet } from "../../core/redis/redis.js";
import * as repo from "./rbac.repository.js";
import type { Permission, Role, RoleBinding } from "./rbac.repository.js";

/** Claims the access token carries (ADR-0009). Derived, never stored on the user. */
export interface UserRoleClaims {
  roles: string[];
  branchIds: string[];
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

export interface SeedResult {
  permissionsAdded: number;
  roles: Role[];
}

/**
 * Brings a tenant's RBAC data in line with the code catalog: the permission list,
 * the default roles, and their grants.
 *
 * Idempotent, and safe to re-run on a live hospital — it re-asserts the grants of
 * SYSTEM roles only. A hospital that has customized a system role will see its
 * changes reset, which is the intended meaning of "system": those roles are ours.
 * Custom roles are never touched.
 */
export async function seedRbac(): Promise<SeedResult> {
  const permissionsAdded = await repo.syncPermissionCatalog(ALL_PERMISSIONS);

  const roles: Role[] = [];
  for (const definition of DEFAULT_ROLES) {
    const role = await repo.upsertRole({
      code: definition.code,
      name: definition.name,
      description: definition.description,
      isSystem: true,
    });
    await repo.setRolePermissions(role.id, [...definition.permissions]);
    roles.push(role);

    // Anyone already holding this role may have just gained or lost something.
    await invalidateRole(role.id);
  }

  return { permissionsAdded, roles };
}

/** Kept for callers that only need the roles (provisioning). */
export const seedSystemRoles = async (): Promise<Role[]> => (await seedRbac()).roles;

/* ── the hot path: effective permissions ─────────────────────────────────── */

/**
 * Every permission code this user holds. Read-through cached.
 *
 * Called on every authorized request, so the cached path is one Redis GET.
 */
export async function getEffectivePermissions(userId: string): Promise<Set<string>> {
  const key = cacheKeys.userPermissions(userId);

  const cached = await cacheGet<string[]>(key);
  if (cached) return new Set(cached);

  const codes = await repo.findPermissionCodesForUser(userId);

  // TTL matches the access token's life: a permission change invalidates
  // explicitly, and this bounds the damage if an invalidation is ever missed.
  await cacheSet(key, codes, env.ACCESS_TOKEN_TTL_SECONDS);
  return new Set(codes);
}

export async function hasPermission(userId: string, code: string): Promise<boolean> {
  return (await getEffectivePermissions(userId)).has(code);
}

/** Drops one user's cached permissions. */
export async function invalidateUser(userId: string): Promise<void> {
  await cacheDel(cacheKeys.userPermissions(userId));
}

/** Drops the cached permissions of everyone holding a role — used when the ROLE changes. */
export async function invalidateRole(roleId: string): Promise<void> {
  const userIds = await repo.findUserIdsWithRole(roleId);
  if (userIds.length === 0) return;
  await cacheDel(...userIds.map((id) => cacheKeys.userPermissions(id)));
}

/* ── role claims (for the token) ─────────────────────────────────────────── */

export async function getRoleClaims(userId: string): Promise<UserRoleClaims> {
  const bindings = await repo.findBindingsForUser(userId);
  const branchIds = new Set<string>();
  for (const binding of bindings) {
    for (const branchId of binding.branchIds) branchIds.add(branchId);
  }
  return { roles: bindings.map((b) => b.roleCode), branchIds: [...branchIds] };
}

/** The branches a user is scoped to. Empty = not restricted to specific branches. */
export async function getUserBranchIds(userId: string): Promise<string[]> {
  return (await getRoleClaims(userId)).branchIds;
}

/* ── administration ──────────────────────────────────────────────────────── */

/**
 * Granting and revoking access is the single most audit-relevant administrative
 * act in the system — every breach investigation begins with "who gave them
 * this?". The role binding lives in `userRoles`, which carries no audit plugin
 * (it is a join table; a field diff of two ObjectIds tells an investigator
 * nothing), so the change is recorded here in the vocabulary a human reads: the
 * role's CODE, the branches, and who did it.
 */
export async function assignRoleByCode(
  userId: string,
  roleCode: string,
  branchIds: string[] = [],
): Promise<void> {
  const role = await repo.findRoleByCode(roleCode);
  if (!role) throw new AppError("HMS-GEN-404", 404, "Role not found", { roleCode });

  await repo.assignRole(userId, role.id, branchIds);
  await invalidateUser(userId); // effective immediately, not in five minutes

  await recordAudit({
    action: "rbac.role.assigned",
    category: "security",
    resource: "user",
    resourceId: userId,
    after: { role: role.code, branchIds },
    meta: { roleId: role.id, isSystem: role.isSystem },
  });

  await publishRolesChanged(userId, "assigned", role.code);
}

export async function revokeRoleByCode(userId: string, roleCode: string): Promise<void> {
  const role = await repo.findRoleByCode(roleCode);
  if (!role) throw new AppError("HMS-GEN-404", 404, "Role not found", { roleCode });

  await repo.revokeRole(userId, role.id);
  await invalidateUser(userId);

  await recordAudit({
    action: "rbac.role.revoked",
    category: "security",
    resource: "user",
    resourceId: userId,
    before: { role: role.code },
    meta: { roleId: role.id },
  });

  await publishRolesChanged(userId, "revoked", role.code);
}

/**
 * The permission cache (`perm:{userId}`) has just been invalidated on THIS pod.
 * Every other pod is still holding the old answer until its TTL runs out — which
 * for a revocation means the user keeps a permission they no longer have, for up
 * to the token lifetime. The event is how the other pods find out; the consumer
 * that fans it out lands with A6, and until then the TTL remains the bound (the
 * same bound ADR-0009 already accepts for token revocation).
 */
async function publishRolesChanged(
  userId: string,
  change: "assigned" | "revoked",
  roleCode: string,
): Promise<void> {
  const claims = await getRoleClaims(userId);
  await publish({
    name: EVENTS.USER_ROLES_CHANGED,
    payload: { userId, change, role: roleCode, roles: claims.roles },
  });
}

export interface CreateRoleInput {
  code: string;
  name: string;
  description?: string;
  permissions: string[];
}

export async function createRole(input: CreateRoleInput): Promise<Role> {
  const existing = await repo.findRoleByCode(input.code);
  if (existing) {
    throw new AppError("HMS-VAL-001", 409, "Role code already exists", { code: input.code });
  }

  assertPermissionsExist(input.permissions);

  const role = await repo.createRole({
    code: input.code.toUpperCase(),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
  });
  await repo.setRolePermissions(role.id, input.permissions);
  return role;
}

/**
 * Replaces a role's permissions.
 *
 * System roles are immutable: a hospital that strips TENANT_ADMIN of
 * `role:manage` locks itself out of its own permission editor, permanently, with
 * no way back except our intervention. Refusing is kinder than allowing it.
 */
export async function setRolePermissions(roleId: string, permissions: string[]): Promise<void> {
  const role = await repo.findRoleById(roleId);
  if (!role) throw new AppError("HMS-GEN-404", 404, "Role not found", { roleId });
  if (role.isSystem) {
    throw new AppError("HMS-AUTH-005", 403, "System roles cannot be edited", { role: role.code });
  }

  assertPermissionsExist(permissions);

  await repo.setRolePermissions(roleId, permissions);
  await invalidateRole(roleId);
}

export async function deleteRole(roleId: string): Promise<void> {
  const role = await repo.findRoleById(roleId);
  if (!role) throw new AppError("HMS-GEN-404", 404, "Role not found", { roleId });
  if (role.isSystem) {
    throw new AppError("HMS-AUTH-005", 403, "System roles cannot be deleted", { role: role.code });
  }

  await invalidateRole(roleId); // while we can still see who held it
  await repo.deleteRole(roleId);
}

export async function getRolePermissions(roleId: string): Promise<string[]> {
  return repo.findPermissionCodesForRole(roleId);
}

/** A grant of a permission that does not exist is a typo, and a typo is a silent hole. */
function assertPermissionsExist(codes: string[]): void {
  const known = new Set(ALL_PERMISSIONS.map((p) => p.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      permissions: [`unknown permission codes: ${unknown.join(", ")}`],
    });
  }
}

/** Who am I in this hospital — used by /auth/me and the UI's menu gating. */
export async function getAuthorizationProfile(userId: string): Promise<{
  roles: string[];
  branchIds: string[];
  permissions: string[];
}> {
  const claims = await getRoleClaims(userId);
  const permissions = await getEffectivePermissions(userId);
  return { ...claims, permissions: [...permissions] };
}

export const listRoles = repo.listRoles;
export const listPermissions = repo.listPermissions;
export const getRoleByCode = repo.findRoleByCode;
export const getRoleById = repo.findRoleById;
export type { Role, RoleBinding, Permission };
