/**
 * What the emergency module does when two patients are merged: move its references onto the
 * survivor. The rule is shared — see core/events/patientMerge.ts — and this file supplies only
 * the one thing that differs, which collection to re-point.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./emergency.repository.js";

export const emergencyConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("emergency", repo.repointPatient),
  },
};
