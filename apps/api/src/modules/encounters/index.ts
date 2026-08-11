/**
 * Encounters module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * THE CENTRAL CLINICAL OBJECT (ADR-0013). Everything clinical built after this —
 * EMR, orders, lab, radiology, admission, billing — hangs off an `encounterId`, and
 * gets it from here.
 *
 * Depends on `patients` (a visit must be FOR someone who exists) and `tenants` (for
 * the encounter policy). **`appointments` depends on THIS, never the reverse** — an
 * appointment is one origin of an encounter, so the arrow points appointment →
 * encounter and the graph stays acyclic.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { encounterRouter } from "./encounter.routes.js";

export {
  admitPatient,
  dischargePatient,
  transferDoctor,
  transferBed,
  type TransferBedInput,
  type TransferBedResult,
  listInpatients,
  startEncounter,
  getEncounter,
  listEncounters,
  getOpenEncounterFor,
  getEpisodeTimeline,
  queuePatient,
  startConsultation,
  sendForInvestigations,
  recordOrderPlaced,
  recordOrderCancelled,
  recordVisitSummary,
  closeEncounter,
  cancelEncounter,
  markLeftWithoutBeingSeen,
  isQueued,
  visitReport,
  doctorProductivity,
  dischargeRegister,
  type Encounter,
  type StartEncounterInput,
  type StartEncounterResult,
} from "./encounter.service.js";
export type { VisitReport, DoctorLoadRow, DischargeRegister } from "./encounter.repository.js";
export { encountersByDoctor } from "./encounter.repository.js";

export {
  ENCOUNTER_STATUSES,
  ENCOUNTER_ORIGINS,
  ENCOUNTER_CLASSES,
  DISCHARGE_DISPOSITIONS,
  canTransition,
  isOpen,
  type EncounterStatus,
  type EncounterOrigin,
  type EncounterClass,
  type DischargeDisposition,
} from "./encounter.model.js";

/** Re-points encounters + episodes onto the survivor on merge. Registered by eventConsumer.ts. */
export { encounterConsumers } from "./encounter.consumers.js";

/** For the reporting response contract. */
export type { DischargeRegister as DischargeRegisterReport } from "./encounter.repository.js";
