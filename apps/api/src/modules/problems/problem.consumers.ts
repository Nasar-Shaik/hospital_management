/**
 * What the problems module does when two patients are merged: move the list onto the survivor.
 * See core/events/patientMerge.ts for why this rule is shared.
 *
 * Registering this is not optional bookkeeping — `patientMergeCoverage.int.test.ts` fails the
 * build for any patient-bearing collection that consumes nothing.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./problem.repository.js";

export const problemConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("problems", repo.repointPatient),
  },
};
