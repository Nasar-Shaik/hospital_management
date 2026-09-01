/**
 * Hospital-profile module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B1).
 *
 * A singleton settings document holding the hospital's own official identity. Self-contained: it
 * reads nothing from and is read by nothing (reference data an administrator maintains).
 */
export { hospitalProfileRouter } from "./hospitalProfile.routes.js";
export { getProfile, saveProfile, type HospitalProfile } from "./hospitalProfile.service.js";
export { OWNERSHIP_TYPES, type OwnershipType } from "./hospitalProfile.model.js";
