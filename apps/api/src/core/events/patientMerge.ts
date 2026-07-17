/**
 * The reaction every module shares when two patients are merged.
 *
 * `patient.patients.merged` is the single most important event in the catalog for
 * data integrity: a module that ignores it keeps serving a chart a human has already
 * declared obsolete (see EVENTS.PATIENTS_MERGED). The RULE is identical everywhere —
 * "re-point my patientId references from the merged record to the survivor" — so the
 * rule lives here once, and each module supplies only the one thing that differs: how
 * to re-point ITS OWN collection.
 *
 * The handler is idempotent because `repoint` is (repointPatientId re-points zero rows
 * on a second pass); at-least-once delivery is therefore harmless.
 */
import { createLogger } from "@medicore/logger";
import type { PatientMergeRef } from "../db/repointPatient.js";
import type { DomainEvent, EventHandler } from "./consumers.js";

/**
 * Builds a module's PATIENTS_MERGED handler. `domain` names the module for logging;
 * `repoint` re-points that module's own references and returns how many rows moved.
 *
 * A throw here retries the whole job (BullMQ), which is what we want for OUR failures
 * (the database was unreachable): the survivor's chart being incomplete is not a state
 * we can leave sitting in a DLQ quietly.
 */
export function onPatientsMerged(
  domain: string,
  repoint: (ref: PatientMergeRef) => Promise<number>,
): EventHandler {
  const logger = createLogger({ service: `${domain}-merge-consumer` });

  return async (event: DomainEvent): Promise<void> => {
    const from = String(event.payload.mergedId ?? "");
    const to = String(event.payload.survivorId ?? "");
    if (!from || !to) {
      // A malformed event is a producer bug, not a transient failure — retrying it
      // five times changes nothing. Say so loudly and drop it.
      logger.error({ eventId: event.eventId }, "patients.merged missing survivorId/mergedId");
      return;
    }

    const moved = await repoint({ from, to });
    if (moved > 0) {
      logger.info({ from, to, moved }, `re-pointed ${domain} references to the surviving patient`);
    }
  };
}
