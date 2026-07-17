/**
 * Drug-safety module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The clinical reference (allergen classes, drug→allergen mapping, cross-reactivity,
 * interactions) and the ONE pure function that screens a prescription against a patient's
 * allergies. No database, no HTTP — it knows drugs, not requests.
 *
 * `prescriptions` and `allergies` both depend on it; it depends on nothing, which is what
 * keeps it a leaf of the module graph.
 */
export {
  ALLERGENS,
  isAllergen,
  allergensFor,
  screen,
  isBlocking,
  hasBlocking,
  type Allergen,
  type AlertKind,
  type AlertSeverity,
  type SafetyAlert,
  type ScreenLine,
  type ScreenAllergy,
} from "./drugSafety.js";
