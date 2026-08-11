/**
 * Hospital-profile routes (Module B1).
 *
 * Both routes are gated on `hospital:manage` — the administrator's permission for the institution's
 * own identity (TENANT_ADMIN holds it). This is not clinical data and not public, so the read is
 * gated the same as the write: only someone who may edit the profile needs to see it.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./hospitalProfile.controller.js";
import { hospitalProfile } from "./hospitalProfile.contract.js";
import { saveHospitalProfileSchema } from "./hospitalProfile.schema.js";

export function hospitalProfileRouter(): Router {
  const router = Router();

  router.get(
    "/hospital-profile",
    authenticate(),
    authorize(PERMISSIONS.HOSPITAL_MANAGE),
    responds(hospitalProfile),
    asyncHandler(controller.getProfile),
  );

  router.put(
    "/hospital-profile",
    authenticate(),
    authorize(PERMISSIONS.HOSPITAL_MANAGE),
    validate(saveHospitalProfileSchema),
    responds(hospitalProfile),
    asyncHandler(controller.saveProfile),
  );

  return router;
}
