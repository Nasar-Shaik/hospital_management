/**
 * What the users module does when two patients are merged: move its references onto the
 * survivor. The rule is shared — see core/events/patientMerge.ts — and this file supplies only
 * the one thing that differs, which collection to re-point.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./user.repository.js";

export const userConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("users", repo.repointPatient),
  },
};
