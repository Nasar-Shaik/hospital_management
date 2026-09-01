/**
 * What the documents module does when two patients are merged: re-point its own references
 * (the patient's documents) onto the survivor. The rule is shared — see core/events/patientMerge.ts.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./document.repository.js";

export const documentConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("documents", repo.repointPatient),
  },
};
