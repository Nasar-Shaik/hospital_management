/**
 * What the theatres module does when two patients are merged: move its references onto the
 * survivor. The rule is shared — see core/events/patientMerge.ts — and this file supplies only
 * the one thing that differs, which collection to re-point.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./theatre.repository.js";

export const theatreConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("theatres", repo.repointPatient),
  },
};
