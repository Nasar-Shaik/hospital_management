/**
 * MAR service (Module D5 / nursing).
 *
 * An administration is charted against a REAL, signed prescription line for THIS visit. The service
 * proves all three before it writes a dose into the record: the prescription belongs to the
 * encounter, it is actually in force (signed — you do not administer a draft or a cancelled order),
 * and the drug is a line on it. The drug's identity is then copied from the immutable signed line,
 * so the MAR row can never disagree with what was prescribed.
 */
import { AppError } from "../../core/errors/appError.js";
import { getPrescription, isDispensable } from "../prescriptions/index.js";
import * as repo from "./mar.repository.js";
import type { MarStatus } from "./mar.model.js";

export type { MedicationAdministration } from "./mar.repository.js";

export const listAdministrations = repo.listByEncounter;

export interface RecordAdministrationInput {
  prescriptionId: string;
  drugCode: string;
  status: MarStatus;
  administeredAt?: string;
  reason?: string;
  note?: string;
}

export async function recordAdministration(
  encounterId: string,
  input: RecordAdministrationInput,
): Promise<repo.MedicationAdministration> {
  const prescription = await getPrescription(input.prescriptionId);
  if (!prescription) {
    throw new AppError("HMS-GEN-404", 404, "Prescription not found", { id: input.prescriptionId });
  }

  // The prescription must be for THIS visit — a dose charted on the wrong stay is a wrong record.
  if (prescription.encounterId !== encounterId) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      prescriptionId: ["this prescription is not for this visit"],
    });
  }

  // Only a live signed prescription can be administered. `isDispensable` is exactly that set
  // (signed / partially_dispensed); a fully `dispensed` one is still in force to administer, so it
  // is allowed too. A draft / cancelled / discarded one is not a lawful order to give against.
  if (!(isDispensable(prescription.status) || prescription.status === "dispensed")) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      status: prescription.status,
      reason: "only a signed prescription can be administered",
    });
  }

  const line = prescription.lines.find((l) => l.drugCode === input.drugCode);
  if (!line) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      drugCode: ["that drug is not on this prescription"],
    });
  }

  // A held dose with no reason is the blank the MAR exists to prevent.
  if (input.status === "held" && !input.reason?.trim()) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      reason: ["say why the dose was held"],
    });
  }

  const administeredAt = input.administeredAt ? new Date(input.administeredAt) : new Date();
  if (Number.isNaN(administeredAt.getTime())) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      administeredAt: ["invalid time"],
    });
  }

  return repo.record({
    encounterId,
    patientId: prescription.patientId,
    prescriptionId: prescription.id,
    drugCode: line.drugCode,
    drugName: line.drugName,
    dose: line.dose,
    route: line.route,
    status: input.status,
    administeredAt,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  });
}
