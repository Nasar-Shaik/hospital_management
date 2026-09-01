/**
 * RBAC module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * `auth` imports `getRoleClaims` to stamp the token; `authorize` imports
 * `getEffectivePermissions` to decide requests. Nothing imports the repository
 * or the models directly.
 *
 * Platform module (PLATFORM_STRATEGY §2) — reusable by any product on this
 * platform.
 */
export {
  // seeding
  seedRbac,
  seedSystemRoles,
  // the hot path
  getEffectivePermissions,
  /** Live branch scope — NOT from the token, so a reassignment takes effect at once. */
  getEffectiveBranchScope,
  hasPermission,
  getRoleClaims,
  getUserBranchIds,
  getAuthorizationProfile,
  listUserIdsWithRoleCode,
  listUserIdsOutsideBranch,
  // administration
  assignRoleByCode,
  revokeRoleByCode,
  createRole,
  setRolePermissions,
  deleteRole,
  getRolePermissions,
  listRoles,
  listPermissions,
  getRoleByCode,
  getRoleById,
  // cache invalidation (callers that change what a user may do)
  invalidateUser,
  invalidateRole,
  type UserRoleClaims,
  type CreateRoleInput,
  type SeedResult,
  type Role,
  type RoleBinding,
  type Permission,
} from "./rbac.service.js";
