/**
 * Prescriptions module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * What the doctor decided the patient should take (STATE_MACHINE_CATALOG §6). Hangs off
 * the ENCOUNTER, never off a note (ADR-0013 §3).
 *
 * Depends on `encounters` (a prescription is written during a visit), `tenants` (the
 * `encounterPolicy.pharmacy` switch decides whether an in-house order is raised at all)
 * and `orders` (the consumer places that order). **Nothing depends on this except
 * `pharmacy`**, and the graph stays acyclic: prescriptions → orders → encounters.
 *
 * There is deliberately NO unscoped read: `prescription:*` is `branch`-scoped, so a
 * pharmacist reads the prescription they are dispensing through the ordinary path, and a
 * branch-restricted one is correctly held to their own branch. See the repository.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { prescriptionRouter } from "./prescription.routes.js";
export { prescriptionConsumers } from "./prescription.consumers.js";

export {
  createPrescription,
  updateDraft,
  signPrescription,
  screenPrescription,
  cancelPrescription,
  discardPrescription,
  amendPrescription,
  getPrescription,
  listPrescriptions,
  dispensesInHouse,
  type Prescription,
  type CreatePrescriptionInput,
  type PrescriptionLineInput,
  type PrescriptionScreening,
  type SignOptions,
} from "./prescription.service.js";

export {
  findByOrderId,
  addDispensedQty,
  setStatus as setPrescriptionStatus,
} from "./prescription.repository.js";

export {
  PRESCRIPTION_STATUSES,
  DRUG_ROUTES,
  DRUG_FREQUENCIES,
  canTransition,
  isDispensable,
  type PrescriptionStatus,
  type PrescriptionLine,
  type DrugRoute,
  type DrugFrequency,
} from "./prescription.model.js";
