/**
 * RBAC service (ADR-0010). Phase 1B scope: system-role seeding, role binding,
 * and the role/branch claims that go into an access token.
 *
 * Phase 1C adds: the permission catalog (`packages/permissions`), role→permission
 * bindings, the three-layer `authorize` middleware (feature flag → permission →
 * row scope) and the release-gating RBAC matrix suite.
 */
import { AppError } from "../../core/errors/appError.js";
import { SYSTEM_ROLES } from "./rbac.model.js";
import * as repo from "./rbac.repository.js";
import type { Role, RoleBinding } from "./rbac.repository.js";

/** Claims the token carries (ADR-0009). Derived, never stored on the user. */
export interface UserRoleClaims {
  roles: string[];
  branchIds: string[];
}

/**
 * Seeds the roles every tenant must have. Idempotent — safe to re-run on an
 * existing tenant, which is what makes it safe to call from provisioning AND
 * from a repair script.
 */
export async function seedSystemRoles(): Promise<Role[]> {
  const seeded: Role[] = [];
  for (const role of SYSTEM_ROLES) {
    seeded.push(await repo.upsertRole({ ...role, isSystem: true }));
  }
  return seeded;
}

/**
 * Resolves the role/branch claims for a user.
 *
 * `branchIds` is the union across bindings; an empty union means "not restricted
 * to specific branches", which the 1C scope layer interprets against the
 * permission's own scope (own/branch/tenant/global) — an empty list is NOT a
 * grant of everything by itself.
 */
export async function getRoleClaims(userId: string): Promise<UserRoleClaims> {
  const bindings = await repo.findBindingsForUser(userId);
  const branchIds = new Set<string>();
  for (const binding of bindings) {
    for (const branchId of binding.branchIds) branchIds.add(branchId);
  }
  return {
    roles: bindings.map((b) => b.roleCode),
    branchIds: [...branchIds],
  };
}

export async function assignRoleByCode(
  userId: string,
  roleCode: string,
  branchIds: string[] = [],
): Promise<void> {
  const role = await repo.findRoleByCode(roleCode);
  if (!role) {
    throw new AppError("HMS-GEN-404", 404, "Role not found", { roleCode });
  }
  await repo.assignRole(userId, role.id, branchIds);
}

export const listRoles = repo.listRoles;
export const getRoleByCode = repo.findRoleByCode;
export const revokeRole = repo.revokeRole;
export type { Role, RoleBinding };
