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
  /**
   * The slot view as a pure function (M3-S5B). The ward round calls this once per stay over data
   * it batch-loaded, so the round and the per-encounter schedule are the SAME derivation rather
   * than two that have to be kept in step.
   */
  slotsForStay,
  isLive,
  isOutstanding,
  type MedicationAdministration,
  type DoseSlotView,
  type DoseState,
} from "./mar.service.js";

export { MAR_STATUSES, type MarStatus } from "./mar.model.js";

/**
 * The dose slot's RESPONSE SCHEMA (M3-S5B).
 *
 * Part of the public interface deliberately: the ward round returns slots inside its own rows, and
 * a second `z.object` describing the same thing in `admissions` would be a contract that drifts
 * from this one silently — two shapes for one wire type, discovered by a client.
 */
export { doseSlot } from "./mar.contract.js";

/** The ward worklist's batch read (M3-S3) — administrations for a whole page of stays. */
export { listByEncounters } from "./mar.repository.js";

/** The dose schedule — pure, and reusable by the nurse worklist without going through HTTP. */
export {
  dosesInRange,
  slotFor,
  DEFAULT_ROUND_TIMES,
  type ScheduledDose,
  type Course,
  type FrequencyKind,
} from "./schedule.js";
