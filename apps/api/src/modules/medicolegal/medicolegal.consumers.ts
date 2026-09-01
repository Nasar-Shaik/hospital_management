/**
 * What the medico-legal module does when two patients are merged: move its references onto the
 * survivor. The rule is shared — see core/events/patientMerge.ts — and this file supplies only the
 * one thing that differs, which collections to re-point.
 *
 * TWO collections, and one consumer rather than two, because the module owns both and a caller
 * outside it must not have to know that consents and death records are stored separately. They are
 * summed so the log line reports what the module moved in total.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import type { PatientMergeRef } from "../../core/db/repointPatient.js";
import * as consents from "./consent.repository.js";
import * as deaths from "./deathRecord.repository.js";

async function repointPatient(ref: PatientMergeRef): Promise<number> {
  const moved = await consents.repointPatient(ref);
  return moved + (await deaths.repointPatient(ref));
}

export const medicolegalConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("medicolegal", repointPatient),
  },
};
