/**
 * Encounter routes (Doc 02 E0, ADR-0013) — the front door of the product.
 *
 * ── GATED ON `module.ops.opd`, NOT ON `module.ops.appointments` ──────────────
 * That unbundling is the whole point. A government hospital buys OPD and never
 * books an appointment in its life; a diagnostic centre takes walk-ins holding a
 * prescription written somewhere else. Under the old model they had to enable an
 * appointment book they would never open, just to put a patient in a queue.
 *
 * Every edition carries the flag. A hospital that cannot admit a patient to a queue
 * is not a cheaper product — it is a broken one.
 *
 * ── THE PERMISSION SPLIT IS A SAFETY BOUNDARY, NOT BUREAUCRACY ──────────────
 * `encounter:create` belongs to the front desk. A DOCTOR does not have it: a doctor
 * who can conjure a visit out of nothing can see a patient who was never registered
 * — which means no UHID, no queue position, and no bill. The desk starts visits;
 * clinicians move them.
 *
 * `encounter:close` is separate from `encounter:update` because closing freezes what
 * can be billed against the visit and asserts the consultation happened. A nurse
 * moves patients along; she does not declare them finished.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./encounter.controller.js";
import {
  cancelEncounterSchema,
  closeEncounterSchema,
  idParamSchema,
  listEncountersQuerySchema,
  startEncounterSchema,
} from "./encounter.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function encounterRouter(): Router {
  const router = Router();

  /** A patient arrives — booked, walked in, or brought in. */
  router.post(
    "/encounters",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_CREATE, FEATURE),
    validate(startEncounterSchema),
    asyncHandler(controller.startEncounter),
  );

  /**
   * The queue board AND the doctor's day, from one endpoint: `?queued=true` is
   * everyone currently waiting or being seen, in TOKEN order — which is arrival
   * order, which is the only order a waiting room accepts as fair.
   */
  router.get(
    "/encounters",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(listEncountersQuerySchema, "query"),
    asyncHandler(controller.listEncounters),
  );

  router.get(
    "/encounters/:id",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getEncounter),
  );

  /**
   * The care story. Declared here rather than under `/episodes` because it is the
   * same permission and the same module — and because the thing a doctor actually
   * asks for is "everything about this visit's history", not "an episode resource".
   */
  router.get(
    "/episodes/:id/timeline",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getEpisodeTimeline),
  );

  /* ── the state machine (STATE_MACHINE_CATALOG §14) ───────────────────────── */

  router.post(
    "/encounters/:id/queue",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.queuePatient),
  );

  router.post(
    "/encounters/:id/start",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.startConsultation),
  );

  /**
   * Sent for tests. THE PATIENT KEEPS THIS ENCOUNTER — that is the entire reason
   * this route exists rather than closing the visit and opening a new one when they
   * come back. Re-registering the returning patient is the commonest data-quality
   * disaster in an OPD.
   */
  router.post(
    "/encounters/:id/investigations",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.sendForInvestigations),
  );

  router.post(
    "/encounters/:id/close",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_CLOSE, FEATURE),
    validate(idParamSchema, "params"),
    validate(closeEncounterSchema),
    asyncHandler(controller.closeEncounter),
  );

  router.post(
    "/encounters/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(cancelEncounterSchema),
    asyncHandler(controller.cancelEncounter),
  );

  /**
   * They waited and left. Distinct from `cancelled` on purpose: a rising
   * left-without-being-seen count is a queue that is too slow, and it is one of the
   * few numbers that predicts a patient coming back sicker. A hospital that cannot
   * see it cannot fix it.
   */
  router.post(
    "/encounters/:id/left",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.markLeftWithoutBeingSeen),
  );

  return router;
}
