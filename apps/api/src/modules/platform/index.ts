/**
 * Platform module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The control plane: operator identity, and the management of hospitals as
 * OBJECTS (create, suspend, re-price, issue an administrator). It is the only
 * module that legitimately acts across the tenancy boundary, which is exactly why
 * its surface is small, its dangerous verbs are role-gated, and every action it
 * takes is recorded in the affected hospital's own audit trail as well as ours.
 *
 * It reads no PHI and must never be given a route that does.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary.
 */
export { platformRouter } from "./platform.routes.js";

export {
  bootstrapFirstOperator,
  upsertDevOperator,
  listHospitals,
  createHospital,
  type CreateHospitalInput,
  type HospitalSummary,
} from "./platform.service.js";

export { PLATFORM_ROLES, type PlatformRole } from "./platform.model.js";
