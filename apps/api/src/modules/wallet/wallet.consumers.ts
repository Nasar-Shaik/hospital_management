/**
 * What the wallet module does when two patients are merged: move the advance balance and its
 * ledger onto the survivor. See core/events/patientMerge.ts for why this rule is shared, and
 * wallet.repository.repointPatient for how the two account documents are folded into one.
 */
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import type { ModuleConsumers } from "../../core/events/consumers.js";
import * as repo from "./wallet.repository.js";

export const walletConsumers: ModuleConsumers = {
  events: {
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("wallet", repo.repointPatient),
  },
};
