/**
 * Allergies module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the STORE of a patient's allergies: recording them, listing them, ruling them out.
 * The prescribing CHECK is not here — it is `drugSafety.screen()`, a pure function the
 * prescription service calls at signing. This module depends on `drugSafety` (for the
 * allergen catalogue) and `patients` (a patient must exist); `prescriptions` depends on
 * this. The graph stays acyclic.
 */
export { allergyRouter } from "./allergy.routes.js";

/**
 * The ward worklist's batch read (M3-S3). Exposed from the repository rather than wrapped in a
 * service call because there is no rule to apply — it is `listActiveForPatient` for many patients,
 * and hospital-wide for exactly the same reason.
 */
export { activeForPatients } from "./allergy.repository.js";

export {
  recordAllergy,
  listAllergies,
  activeAllergies,
  refuteAllergy,
  labelFor,
  type Allergy,
  type RecordAllergyInput,
} from "./allergy.service.js";

export {
  ALLERGY_STATUSES,
  ALLERGY_SEVERITIES,
  type AllergyStatus,
  type AllergySeverity,
} from "./allergy.model.js";

/** Re-points allergies onto the survivor on merge. Registered by eventConsumer.ts. */
export { allergyConsumers } from "./allergy.consumers.js";
