/**
 * Consultations module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module D3).
 *
 * Owns the structured consultation note. Depends on `encounters` — it hangs the note on a real
 * encounter and syncs the OPD-slip lines back through the encounter's own `recordVisitSummary`.
 * Nothing reads back into it, so the graph stays acyclic (consultations → encounters).
 */
export { consultationRouter } from "./consultation.routes.js";

export {
  getConsultation,
  saveConsultation,
  type ConsultationNote,
} from "./consultation.service.js";

export { DIAGNOSIS_TYPES, type DiagnosisType, type Diagnosis } from "./consultation.model.js";

/** Re-points consultation notes onto the survivor on merge. Registered by eventConsumer.ts. */
export { consultationConsumers } from "./consultation.consumers.js";
