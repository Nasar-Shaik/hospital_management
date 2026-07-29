/**
 * MAR module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module D5).
 *
 * Owns the medication administration record. Depends on `prescriptions` (to validate a dose is
 * charted against a real, signed line and to copy the drug's identity from it). Nothing reads back
 * into it, so the graph stays acyclic (mar → prescriptions).
 */
export { marRouter } from "./mar.routes.js";

export {
  listAdministrations,
  recordAdministration,
  type MedicationAdministration,
} from "./mar.service.js";

export { MAR_STATUSES, type MarStatus } from "./mar.model.js";
