/**
 * Allergy routes.
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Unlike IPD or theatre, allergy tracking is not an edition upsell. A single-doctor clinic
 * that prescribes must be able to record and see allergies, or it is prescribing blind. So
 * this router carries no `feature` gate — every edition has it.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `allergy:read`   — see the list. Doctors, nurses AND pharmacists (the last hands over the
 *                    drug and is the final check). Scoped `tenant`: an allergy follows the
 *                    patient across branches, because a reaction does not respect a branch
 *                    boundary (see the permission catalogue and allergy.repository.ts).
 * `allergy:manage` — add one, or rule one out. Doctors and nurses. A pharmacist reads the
 *                    list but does not edit a clinical finding they did not make.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./allergy.controller.js";
import { allergy } from "./allergy.contract.js";
import {
  idParamSchema,
  patientIdParamSchema,
  recordAllergySchema,
  refuteAllergySchema,
} from "./allergy.schema.js";

export function allergyRouter(): Router {
  const router = Router();

  router.get(
    "/patients/:patientId/allergies",
    authenticate(),
    authorize(PERMISSIONS.ALLERGY_READ),
    validate(patientIdParamSchema, "params"),
    responds(allergy.array()),
    asyncHandler(controller.list),
  );

  router.post(
    "/patients/:patientId/allergies",
    authenticate(),
    authorize(PERMISSIONS.ALLERGY_MANAGE),
    validate(patientIdParamSchema, "params"),
    validate(recordAllergySchema),
    responds(allergy, { status: 201 }),
    asyncHandler(controller.record),
  );

  /** Rules an allergy out — it stops firing the prescribing check but stays on the record. */
  router.post(
    "/allergies/:id/refute",
    authenticate(),
    authorize(PERMISSIONS.ALLERGY_MANAGE),
    validate(idParamSchema, "params"),
    validate(refuteAllergySchema),
    responds(allergy),
    asyncHandler(controller.refute),
  );

  return router;
}
