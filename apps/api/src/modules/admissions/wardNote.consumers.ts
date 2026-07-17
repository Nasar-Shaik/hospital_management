/**
 * What the admissions module does when two patients are merged: re-point its own references
 * (ward notes) onto the survivor. The rule is shared — see core/events/patientMerge.ts.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./wardNote.repository.js";

export const wardNoteConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("admissions", repo.repointPatient),
  },
};
