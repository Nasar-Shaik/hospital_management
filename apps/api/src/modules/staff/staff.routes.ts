/**
 * Staff directory routes (Doc 02 A3 pages: Staff Directory, Invitations).
 *
 * Note how the permissions differ per verb. Reading the directory (`user:read`)
 * is something most staff need; creating an account (`user:create`) and resetting
 * someone's password (`user:update`) are administrative. They are separate
 * permissions precisely so a hospital can hand out the harmless one widely.
 *
 * Role ASSIGNMENT deliberately lives on the RBAC router under its own permission
 * (`user:assign-role`), not here — it is the privilege-escalation path, and it
 * should not come free with "can create a user".
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./staff.controller.js";
import {
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  setUserStatusSchema,
  updateUserSchema,
} from "./staff.schema.js";

export function staffRouter(): Router {
  const router = Router();

  router.get(
    "/users",
    authenticate(),
    authorize(PERMISSIONS.USER_READ),
    validate(listUsersQuerySchema, "query"),
    asyncHandler(controller.listStaff),
  );

  /**
   * The doctors directory — names only, gated on `encounter:read` rather than
   * `user:read`. The front desk must be able to choose a doctor without being handed
   * a personnel file. See the controller.
   */
  router.get(
    "/doctors",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ),
    asyncHandler(controller.listDoctors),
  );

  // One doctor's card (name, qualification, signature) for the OPD slip. Same authority as the
  // directory — a document the desk prints needs the signing doctor, not the personnel file.
  router.get(
    "/doctors/:id",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getDoctorCard),
  );

  router.get(
    "/users/:id",
    authenticate(),
    authorize(PERMISSIONS.USER_READ),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getStaff),
  );

  router.post(
    "/users",
    authenticate(),
    authorize(PERMISSIONS.USER_CREATE),
    validate(createUserSchema),
    asyncHandler(controller.createStaff),
  );

  router.patch(
    "/users/:id",
    authenticate(),
    authorize(PERMISSIONS.USER_UPDATE),
    validate(idParamSchema, "params"),
    validate(updateUserSchema),
    asyncHandler(controller.updateStaff),
  );

  router.post(
    "/users/:id/status",
    authenticate(),
    authorize(PERMISSIONS.USER_DEACTIVATE),
    validate(idParamSchema, "params"),
    validate(setUserStatusSchema),
    asyncHandler(controller.setStaffStatus),
  );

  router.post(
    "/users/:id/reset-password",
    authenticate(),
    authorize(PERMISSIONS.USER_UPDATE),
    validate(idParamSchema, "params"),
    validate(resetPasswordSchema),
    asyncHandler(controller.resetStaffPassword),
  );

  return router;
}
