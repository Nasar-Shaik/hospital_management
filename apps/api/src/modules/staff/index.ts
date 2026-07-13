/**
 * Staff module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The orchestration layer for "a person who works at this hospital". Depends on
 * `users`, `auth` and `rbac`; NOTHING depends on it — which is what lets it reach
 * across all three without creating a cycle.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary. A School ERP
 * creates teachers with exactly this code.
 */
export { staffRouter } from "./staff.routes.js";

export {
  createStaff,
  listStaff,
  getStaff,
  updateStaff,
  setStaffStatus,
  resetStaffPassword,
  type StaffMember,
  type CreateStaffInput,
  type CreateStaffResult,
} from "./staff.service.js";
