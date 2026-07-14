/**
 * What the patients module does when something happens to a patient.
 *
 * This is where the healthcare MEANING of a notification lives — the notifications
 * module itself must never learn what a UHID is (PLATFORM_STRATEGY Rule P1). It
 * delivers messages; this file decides that a newly registered patient deserves one.
 */
import { createLogger } from "@medicore/logger";
import { getContext } from "../../core/context/requestContext.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { notify } from "../notifications/index.js";
import { getById as getTenant } from "../tenants/index.js";
import { getPatient } from "./patient.service.js";

const logger = createLogger({ service: "patient-consumers" });

/**
 * The welcome message. Its real job is to put the UHID in the patient's pocket.
 *
 * A patient who has their UHID can be found instantly at any desk in any branch;
 * one who does not becomes a name-and-date-of-birth search, which is exactly the
 * fuzzy lookup that creates the duplicate record the MPI then has to merge. This
 * message is, quietly, a data-quality feature.
 */
async function onPatientRegistered(event: DomainEvent): Promise<void> {
  const patientId = String(event.payload.patientId ?? "");
  const patient = await getPatient(patientId);
  if (!patient) {
    // Registered, then merged away before we got here. Not an error, and NOT a
    // retry — the record is gone by design and will not come back.
    logger.info({ patientId }, "patient no longer resolvable — no welcome sent");
    return;
  }

  const ctx = getContext();
  const tenant = await getTenant(ctx.tenantId);

  await notify({
    templateKey: "patient.welcome",
    recipient: {
      ...(patient.contact.email ? { address: patient.contact.email } : {}),
      name: patient.name,
      type: "patient",
      id: patient.id,
    },
    data: {
      name: patient.name,
      uhid: patient.uhid,
      hospital: tenant?.hospitalName ?? "",
    },
    // One welcome per registration, forever. Keyed on the PATIENT, not the event:
    // if this event is ever replayed from the outbox (an operator draining a DLQ, a
    // restore), the patient must not be welcomed to the hospital a second time.
    dedupeKey: `patient.welcome:${patient.id}`,
    eventId: event.eventId,
    ...(event.branchId ? { branchId: event.branchId } : {}),
  });
}

export const patientConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENT_REGISTERED]: onPatientRegistered,
  },
};
