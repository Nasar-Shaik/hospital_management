/**
 * Insurance module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns patient insurance policies and the claims filed against them. A leaf: it reads a policy to
 * validate a claim within itself, stores `patientId`/`encounterId` as opaque ids, and nothing
 * depends on it — so the graph stays acyclic.
 */
export { insuranceRouter } from "./insurance.routes.js";

export {
  listPolicies,
  listClaims,
  linkPolicy,
  updatePolicy,
  fileClaim,
  transitionClaim,
  settleClaim,
  type InsurancePolicy,
  type InsuranceClaim,
} from "./insurance.service.js";

export {
  POLICY_TYPES,
  POLICY_RELATIONSHIPS,
  POLICY_STATUSES,
  CLAIM_TYPES,
  CLAIM_STATUSES,
  canTransition,
  type PolicyType,
  type PolicyRelationship,
  type PolicyStatus,
  type ClaimType,
  type ClaimStatus,
} from "./insurance.model.js";
