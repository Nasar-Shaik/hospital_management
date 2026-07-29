/**
 * Medico-legal module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module C3).
 *
 * Owns the hospital's two statutory records: informed CONSENT and the DEATH record. Depends on the
 * encounter spine and the patient master to know a record is real and whose it is; nothing depends
 * back on it, so the module graph stays acyclic.
 */
export { medicolegalRouter } from "./medicolegal.routes.js";

export {
  listConsents,
  getConsent,
  recordConsent,
  withdrawConsent,
  getDeathRecordForEncounter,
  getDeathRecordForPatient,
  recordDeath,
  type Consent,
  type DeathRecord,
} from "./medicolegal.service.js";
