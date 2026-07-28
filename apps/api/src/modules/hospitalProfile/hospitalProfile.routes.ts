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
import * as controller from "./hospitalProfile.controller.js";
import { saveHospitalProfileSchema } from "./hospitalProfile.schema.js";

export function hospitalProfileRouter(): Router {
  const router = Router();

  router.get(
    "/hospital-profile",
    authenticate(),
    authorize(PERMISSIONS.HOSPITAL_MANAGE),
    asyncHandler(controller.getProfile),
  );

  router.put(
    "/hospital-profile",
    authenticate(),
    authorize(PERMISSIONS.HOSPITAL_MANAGE),
    validate(saveHospitalProfileSchema),
    asyncHandler(controller.saveProfile),
  );

  return router;
}
