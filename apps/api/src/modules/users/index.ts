/**
 * Users module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Other modules import ONLY from this file. `auth` and `rbac` both depend on it;
 * it depends on nothing, which is what keeps the identity graph acyclic.
 *
 * Platform module (PLATFORM_STRATEGY §2): no healthcare vocabulary here — a
 * School ERP or HRMS built on this platform reuses it unchanged.
 */
export {
  createUser,
  transitionStatus,
  getById,
  getByEmail,
  recordLogin,
  setMfaEnabled,
  listUsers,
  updateUser,
  countUsers,
  InvalidUserTransitionError,
} from "./user.service.js";

export type {
  User,
  CreateUserInput,
  UpdateUserInput,
  ListUsersFilter,
  UserPage,
} from "./user.repository.js";
export { USER_STATUSES, type UserStatus } from "./user.model.js";
