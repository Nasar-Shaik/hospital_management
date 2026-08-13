/**
 * Vitals routes.
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Like allergies, observations are not an edition upsell. A single-doctor clinic that takes a
 * blood pressure must be able to chart it; a hospital that cannot is not a hospital.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `vitals:record` — chart a reading. The NURSE role holds it, and in the seeded catalogue it is
 *                   the ONLY role that does. Reception does not: the desk books and takes money,
 *                   it does not measure patients. Nor, today, does DOCTOR — this header used to
 *                   claim otherwise, and M3-S4's integration suite proved the claim false (a
 *                   doctor charting a BP gets a 403). Whether to grant it is a hospital's policy
 *                   decision and the catalogue is editable per tenant, so it is left alone here
 *                   rather than widened by a comment nobody checked.
 * `emr:read`      — read the chart. It is clinical PHI, so it sits behind the clinical read
 *                   permission rather than `encounter:read`: a receptionist can see THAT a visit
 *                   exists without being shown the patient's blood pressure.
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
    authorize(PERMISSIONS.EMR_READ),
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
