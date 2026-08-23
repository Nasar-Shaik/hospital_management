/**
 * MRD module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module MRD).
 *
 * Owns the ICD-10 code master and the coded diagnoses that feed the disease register. Depends on
 * `encounters` to hang a coding on a real visit; nothing reads back, so the graph stays acyclic.
 */
export { mrdRouter } from "./mrd.routes.js";

export {
  listIcd,
  findActiveIcdByCode,
  createIcd,
  updateIcd,
  getCoding,
  saveCoding,
  diseaseRegister,
  type IcdCode,
  type EncounterCoding,
  type CodedDiagnosis,
  type DiseaseRegisterRow,
} from "./mrd.service.js";

/** Re-points coded diagnoses onto the survivor on merge. Registered by eventConsumer.ts. */
export { mrdConsumers } from "./mrd.consumers.js";
