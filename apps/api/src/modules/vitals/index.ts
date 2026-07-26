/**
 * Vitals module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the CHART of physiological observations: recording a reading against a visit, reading a
 * visit's readings, and reading a patient's trend across visits. It depends on `encounters` (a
 * reading must belong to a real visit, and the visit is where the patient comes from); nothing
 * clinical depends on it, so the graph stays acyclic.
 *
 * The reference-range flags are exported because the IP treatment sheet and the consultation
 * view both paint them, and neither should carry a second copy of the ranges.
 */
export { vitalsRouter } from "./vitals.routes.js";

export {
  recordVitals,
  listForEncounter,
  listForPatient,
  latestForEncounters,
  assess,
  flagFor,
  bmiOf,
  VITAL_FIELDS,
  type VitalsReading,
  type AssessedVitals,
  type VitalField,
  type VitalFlag,
  type RecordVitalsInput,
} from "./vitals.service.js";

export { TRIAGE_LEVELS, type TriageLevel } from "./vitals.model.js";

/** Re-points readings onto the survivor on merge. Registered by eventConsumer.ts. */
export { vitalsConsumers } from "./vitals.consumers.js";
