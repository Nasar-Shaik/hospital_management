/**
 * Mortuary service (Module support.mortuary) — receiving a deceased body into custody and releasing
 * it again.
 *
 * A body cannot enter the mortuary until the death it represents has been recorded: the death record
 * is the source of truth for WHOSE body this is and whether it is a medico-legal case. So `receive`
 * loads the death record for the encounter, derives the patient and the medico-legal flag from it,
 * and refuses if no death has been filed. Release then enforces the hold — a medico-legal body needs
 * a police/magistrate clearance before it leaves. Depends on `medicolegal` and `patients`; nothing
 * reads back, so the module graph stays acyclic (mortuary → medicolegal → encounters/patients).
 */
import { AppError } from "../../core/errors/appError.js";
import { getDeathRecordForEncounter } from "../medicolegal/index.js";
import { getPatient } from "../patients/index.js";
import * as repo from "./mortuary.repository.js";

export type { MortuaryEntry } from "./mortuary.repository.js";
export type { MortuaryStatus } from "./mortuary.model.js";

export const listRegister = repo.list;
export const getEntry = repo.findById;
export const getEntryForEncounter = repo.findForEncounter;

export interface ReceiveBodyInput {
  encounterId: string;
  tagNumber: string;
  storageUnit?: string;
  remarks?: string;
}

export async function receiveBody(input: ReceiveBodyInput): Promise<repo.MortuaryEntry> {
  // The death record is the gate: no body enters the mortuary without a recorded death, and it is
  // that record — not the caller — that says who the deceased is and whether the law is holding them.
  const death = await getDeathRecordForEncounter(input.encounterId);
  if (!death) {
    throw new AppError("HMS-VAL-001", 422, "Record the death before receiving the body", {
      encounterId: input.encounterId,
      hint: "the death record is the mortuary's source of truth for the patient and medico-legal status",
    });
  }

  const patient = await getPatient(death.patientId);
  if (!patient)
    throw new AppError("HMS-GEN-404", 404, "Patient not found", { id: death.patientId });

  try {
    return await repo.create({
      patientId: death.patientId,
      encounterId: input.encounterId,
      deathRecordId: death.id,
      deceasedName: patient.name,
      tagNumber: input.tagNumber,
      medicoLegal: death.medicoLegal,
      ...(input.storageUnit ? { storageUnit: input.storageUnit } : {}),
      ...(input.remarks ? { remarks: input.remarks } : {}),
    });
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-STATE-001", 409, "This body is already in the mortuary register", {
        encounterId: input.encounterId,
        hint: "a body is registered once per stay — open the existing entry",
      });
    }
    throw err;
  }
}

export interface ReleaseBodyInput {
  releasedTo: string;
  releasedRelationship: string;
  clearanceRef?: string;
  remarks?: string;
}

export async function releaseBody(
  id: string,
  input: ReleaseBodyInput,
): Promise<repo.MortuaryEntry> {
  const entry = await repo.findById(id);
  if (!entry) throw new AppError("HMS-GEN-404", 404, "Mortuary entry not found", { id });
  if (entry.status === "released") {
    throw new AppError("HMS-STATE-001", 409, "This body has already been released", {
      id,
      releasedTo: entry.releasedTo,
    });
  }

  // The medico-legal hold: a body the police are holding may not be handed over without their
  // clearance. This is a safety rule, not paperwork — enforce it here, not in the UI.
  if (entry.medicoLegal && !input.clearanceRef?.trim()) {
    throw new AppError("HMS-VAL-001", 422, "A medico-legal body needs a clearance reference", {
      id,
      hint: "record the police / magistrate no-objection reference before releasing",
    });
  }

  const released = await repo.release(id, input);
  if (!released) {
    // Lost the race — someone released it between our read and write.
    throw new AppError("HMS-STATE-001", 409, "This body has already been released", { id });
  }
  return released;
}
