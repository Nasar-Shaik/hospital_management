/**
 * Emergency module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module D10).
 *
 * Owns the ED triage record and the emergency board. It READS `encounters` (the visit and its
 * lifecycle) and `patients` (to name a row); nothing reads back into it, so the graph stays
 * acyclic: emergency → encounters → patients.
 *
 * It deliberately owns NO clinical workflow of its own. An ED doctor's orders, prescriptions,
 * imaging, admission and discharge all go through the modules that already own them — there is no
 * emergency copy of any of it.
 */
export { emergencyRouter } from "./emergency.routes.js";

export { triage, transferOut, board, type Triage, type EdBoardRow } from "./emergency.service.js";

export {
  TRIAGE_PRIORITIES,
  PRIORITY_RANK,
  UNTRIAGED_RANK,
  type TriagePriority,
} from "./emergency.model.js";
