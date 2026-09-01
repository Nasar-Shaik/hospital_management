/**
 * MAR routes (Module D5 / nursing).
 *
 * ── GATED ON `module.clinical.nursing` ──────────────────────────────────────
 * The MAR is a nursing record; the editions that staff a ward carry the flag. A tenant without it
 * gets "not in your edition" rather than a permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`emr:read`)        — read the MAR. Everyone clinical: the doctor reviewing the chart and the
 *                            pharmacist reconciling both need to see what was actually given.
 * ADMINISTER (`mar:administer`) — chart a dose. The nurse's own act — its own permission, separate
 *                            from writing a ward note (`emr:write`), because giving a drug and
 *                            writing a line about it are different responsibilities.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./mar.controller.js";
import { medicationAdministration, doseSlot } from "./mar.contract.js";
import {
  recordAdministrationSchema,
  encounterIdParamSchema,
  scheduleQuerySchema,
} from "./mar.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_NURSING } as const;

export function marRouter(): Router {
  const router = Router();

  router.get(
    "/encounters/:id/medication-administrations",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(encounterIdParamSchema, "params"),
    responds(medicationAdministration.array()),
    asyncHandler(controller.listAdministrations),
  );

  /**
   * What is DUE, and what has happened to each dose (M3-S1).
   *
   * `emr:read` like its sibling: the doctor reviewing the round and the nurse working it are
   * asking the same question, and neither is a write.
   *
   * This is the endpoint that makes "was the 2pm antibiotic given?" answerable. It is also the
   * reconciliation path a client uses after a lost response — ask the server what it holds rather
   * than guessing from a local clock.
   */
  router.get(
    "/encounters/:id/medication-schedule",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(encounterIdParamSchema, "params"),
    validate(scheduleQuerySchema, "query"),
    responds(doseSlot.array()),
    asyncHandler(controller.getSchedule),
  );

  router.post(
    "/encounters/:id/medication-administrations",
    authenticate(),
    authorize(PERMISSIONS.MAR_ADMINISTER, FEATURE),
    validate(encounterIdParamSchema, "params"),
    validate(recordAdministrationSchema),
    responds(medicationAdministration, { status: 201 }),
    idempotent("Replays the dose this key already recorded as given."),
    asyncHandler(controller.recordAdministration),
  );

  return router;
}
