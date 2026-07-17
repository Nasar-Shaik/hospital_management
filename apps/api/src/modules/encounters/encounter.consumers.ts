/**
 * What the encounters module does when two patients are merged: re-point its own references
 * (encounters and episodes of care) onto the survivor. The rule is shared — see core/events/patientMerge.ts.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./encounter.repository.js";

export const encounterConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("encounters", repo.repointPatient),
  },
};
