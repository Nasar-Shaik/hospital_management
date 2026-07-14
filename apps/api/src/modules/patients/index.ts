/**
 * Patients module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Owns the patient master and the MPI. Other modules import ONLY from this file.
 *
 * NOT a platform module (PLATFORM_STRATEGY §2): this is the first module in the
 * codebase whose vocabulary is healthcare. A School ERP built on this platform
 * reuses `users`, `auth`, `rbac`, `tenants` and `subscriptions` unchanged — and
 * does not take this one. That boundary is the whole reason the platform modules
 * were kept free of clinical language.
 *
 * `getPatient`/`countPatients` are the seams other modules will use: appointments
 * needs to prove a patient exists before booking one, and everything downstream
 * holds a `patientId` and consumes `patient.patients.merged` to re-point it.
 */
export { patientRouter } from "./patient.routes.js";

export {
  registerPatient,
  mergePatients,
  getPatient,
  getPatientByUhid,
  listPatients,
  updatePatient,
  findDuplicates,
  countPatients,
  type Patient,
  type RegisterPatientInput,
  type RegisterPatientResult,
} from "./patient.service.js";

export { PATIENT_STATUSES, GENDERS, BLOOD_GROUPS } from "./patient.model.js";
export type { PatientStatus, Gender, BloodGroup } from "./patient.model.js";
export { DUPLICATE_THRESHOLD, type DuplicateCandidate } from "./mpi.js";
