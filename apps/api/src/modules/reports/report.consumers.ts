/**
 * What the reports module does when two patients are merged: re-point its own references
 * (report files) onto the survivor. The rule is shared — see core/events/patientMerge.ts.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./report.repository.js";

export const reportConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("reports", repo.repointPatient),
  },
};
