/**
 * Subscriptions module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns what a hospital BOUGHT: the plan, its limits, and whether the next thing
 * they create is still inside them. `staff` calls `assertWithinLimit` before
 * creating an account; future modules do the same before creating a branch, a bed
 * or a patient.
 *
 * Reads the edition catalog from `@medicore/permissions` (code) and the tenant's
 * chosen plan from the master registry (data). It never decides *permissions* —
 * that is `rbac` — and the two must not be confused: a plan says what the hospital
 * may have, a permission says what a person may do.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary, with ONE deliberate
 * exception kept behind a single seam: `subscription.counters.ts` says what a "doctor" or a "bed"
 * is, because a meter has to count something real. Everything else here — the limit arithmetic,
 * the 80% nudge, counted-vs-capped — is product-neutral, and swapping that one file is what
 * porting this module to another product means.
 */
export { subscriptionRouter } from "./subscription.routes.js";

export {
  getSubscription,
  getCachedUsage,
  assertWithinLimit,
  limitWarnings,
  changePlan,
  seedPlans,
  listPlans,
  LIMIT_METRICS,
  USAGE_METRICS,
  type LimitMetric,
  type UsageLine,
  type SubscriptionView,
} from "./subscription.service.js";

export type { Plan } from "./subscription.repository.js";

/** For the platform response contracts — a hospital detail embeds its plan and usage. */
export { plan, subscriptionView, usageLine } from "./subscription.contract.js";
