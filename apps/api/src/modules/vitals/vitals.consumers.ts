/**
 * What the vitals module does when two patients are merged: move the readings onto the
 * survivor. See core/events/patientMerge.ts for why this rule is shared.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./vitals.repository.js";

export const vitalsConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("vitals", repo.repointPatient),
  },
};
