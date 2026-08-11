/**
 * Vitals routes.
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Like allergies, observations are not an edition upsell. A single-doctor clinic that takes a
 * blood pressure must be able to chart it; a hospital that cannot is not a hospital.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `vitals:record` — chart a reading. NURSES above all (this is the permission that finally gives
 *                   the seeded nurse role its daily job), and doctors, who take observations too.
 *                   Reception does NOT have it: the desk books and takes money, it does not
 *                   measure patients.
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
