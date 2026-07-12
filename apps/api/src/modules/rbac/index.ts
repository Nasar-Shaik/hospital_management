/**
 * RBAC module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * `auth` imports `getRoleClaims` from here to stamp the access token. Nothing
 * imports the repository or the models directly.
 *
 * Platform module (PLATFORM_STRATEGY §2) — reusable by any product on this
 * platform.
 */
export {
  seedSystemRoles,
  getRoleClaims,
  assignRoleByCode,
  listRoles,
  getRoleByCode,
  revokeRole,
  type UserRoleClaims,
  type Role,
  type RoleBinding,
} from "./rbac.service.js";

export { SYSTEM_ROLES } from "./rbac.model.js";
