/**
 * What the allergies module does when two patients are merged: move the allergies onto
 * the survivor. See core/events/patientMerge.ts for why this rule is shared, and
 * allergy.repository.repointPatient for why this particular re-point matters most.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./allergy.repository.js";

export const allergyConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("allergies", repo.repointPatient),
  },
};
