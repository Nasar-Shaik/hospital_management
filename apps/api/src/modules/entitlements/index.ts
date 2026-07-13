/**
 * Entitlements module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Answers layer 1 of authorization: what did this hospital buy? Consumed by the
 * `authorize` middleware and, later, by the subscriptions module (A2) which will
 * own plan changes and usage limits.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary.
 */
export {
  getEnabledFeatures,
  isFeatureEnabled,
  setFeatureOverride,
  clearFeatureOverride,
  invalidateFeatures,
} from "./entitlement.service.js";
