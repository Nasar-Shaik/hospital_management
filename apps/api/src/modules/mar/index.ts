/**
 * MAR module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module D5).
 *
 * Owns the medication administration record, and the dose schedule derived from a prescription's
 * frequency (M3-S1). Depends on `prescriptions` (to validate a dose is charted against a real,
 * signed line and to copy the drug's identity from it) and `branches` (a round is a wall-clock
 * event in the ward's zone). Nothing reads back into it, so the graph stays acyclic.
 */
export { marRouter } from "./mar.routes.js";

export {
  listAdministrations,
  recordAdministration,
  getSchedule,
  type MedicationAdministration,
  type DoseSlotView,
  type DoseState,
} from "./mar.service.js";

export { MAR_STATUSES, type MarStatus } from "./mar.model.js";

/** The dose schedule — pure, and reusable by the nurse worklist without going through HTTP. */
export {
  dosesInRange,
  slotFor,
  DEFAULT_ROUND_TIMES,
  type ScheduledDose,
  type Course,
  type FrequencyKind,
} from "./schedule.js";
