/**
 * Tenants module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Other modules may import ONLY from this file: the service functions and types
 * below. Reaching into `tenant.repository.ts` or `tenant.model.ts` from another
 * module is a boundary violation and fails CI (dependency-cruiser).
 *
 * Platform module (PLATFORM_STRATEGY §2: reusable across future products —
 * no healthcare vocabulary in here).
 */
export {
  provisionTenant,
  transitionStatus,
  migrateTenant,
  getBySlug,
  getById,
  InvalidTenantTransitionError,
  type ProvisionTenantInput,
  type ProvisionResult,
} from "./tenant.service.js";

export type { TenantRegistryEntry } from "./tenant.repository.js";
export { TENANT_STATUSES, SERVABLE_TENANT_STATUSES, type TenantStatus } from "./tenant.model.js";
