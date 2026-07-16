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
