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

/** Fleet loops (outbox relay, audit anchoring, migrations) walk every servable hospital. */
export { listServable } from "./tenant.repository.js";

/**
 * The encounter policy in force for a hospital: its `organizationType` preset plus
 * its deliberate overrides (ADR-0013 §5–6).
 *
 * Every caller that needs to know how a hospital behaves asks THIS — never
 * `tenant.organizationType`. `policy.billingMode === "zero_tariff"` is a question
 * about billing; `organizationType === "government_hospital"` is a branch, and it
 * is forbidden (a government hospital may run a paid private ward, so the branch is
 * not even true).
 */
export { policyOf } from "./tenant.repository.js";

export type { TenantRegistryEntry } from "./tenant.repository.js";
export { TENANT_STATUSES, SERVABLE_TENANT_STATUSES, type TenantStatus } from "./tenant.model.js";
