/**
 * Admissions module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The ward's half of an inpatient stay: the daily notes, and the discharge summary the
 * patient goes home with.
 *
 * It does NOT own the admission. **The IP encounter IS the admission** (ADR-0013 §1), so
 * admitting, discharging and the bed live on `encounters`. This module depends on
 * `encounters`; nothing depends on this, which is what keeps the graph acyclic.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { admissionRouter } from "./admission.routes.js";

export {
  addNote,
  dischargeWithSummary,
  recordOutcome,
  notesFor,
  dischargeSummaryFor,
  type WardNote,
  type AddNoteInput,
  type DischargeInput,
  type OutcomeInput,
  type TerminalOutcome,
} from "./admission.service.js";

export { WARD_NOTE_TYPES, type WardNoteType } from "./wardNote.model.js";
