/**
 * Vitals routes.
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Like allergies, observations are not an edition upsell. A single-doctor clinic that takes a
 * blood pressure must be able to chart it; a hospital that cannot is not a hospital.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `vitals:record` — chart a reading. NURSE, and now the front desk (RECEPTIONIST / FRONT_OFFICE).
 *                   This header used to say "the desk books and takes money, it does not measure
 *                   patients", and left the grant alone as a hospital's policy decision. That
 *                   decision has since been made the other way, on purpose: in an Indian OPD the
 *                   weighing scale is beside the counter, and while NURSE was the sole holder
 *                   nothing was measured at all, because there is no nurse at the front door.
 *                   DOCTOR still does not hold it — M3-S4's suite proved a doctor charting a BP
 *                   gets a 403 — and that remains a hospital's call rather than a comment's.
 *
 * `vitals:read`   — read the observations ON A VISIT. Split out of `emr:read` when the desk
 *                   started taking them: a desk that may WRITE a measurement but not read it back
 *                   cannot print it on the OP slip it hands the patient, and granting `emr:read`
 *                   to fix that would open every consultation note in the hospital. Every role
 *                   that held `emr:read` holds this too, so nobody lost a read.
 *
 * `emr:read`      — the TREND across visits, below. That is clinical history rather than today's
 *                   intake, and it stays where it was: a receptionist can see THAT a visit exists,
 *                   and what was measured on it, without being shown the patient's chart.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./vitals.controller.js";
import { assessedVitals } from "./vitals.contract.js";
import {
  encounterIdParamSchema,
  listPatientVitalsQuerySchema,
  patientIdParamSchema,
  recordVitalsSchema,
} from "./vitals.schema.js";

export function vitalsRouter(): Router {
  const router = Router();

  router.post(
    "/encounters/:encounterId/vitals",
    authenticate(),
    authorize(PERMISSIONS.VITALS_RECORD),
    validate(encounterIdParamSchema, "params"),
    validate(recordVitalsSchema),
    responds(assessedVitals, { status: 201 }),
    idempotent("Replays the observation this key already recorded."),
    asyncHandler(controller.record),
  );

  router.get(
    "/encounters/:encounterId/vitals",
    authenticate(),
    authorize(PERMISSIONS.VITALS_READ),
    validate(encounterIdParamSchema, "params"),
    responds(assessedVitals.array()),
    asyncHandler(controller.listForEncounter),
  );

  /** The trend across visits — what a chronic patient's clinician actually looks at. */
  router.get(
    "/patients/:patientId/vitals",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(patientIdParamSchema, "params"),
    validate(listPatientVitalsQuerySchema, "query"),
    responds(assessedVitals.array()),
    asyncHandler(controller.listForPatient),
  );

  return router;
}
