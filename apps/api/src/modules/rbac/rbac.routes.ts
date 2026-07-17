/**
 * RBAC routes (Doc 02 A4, Doc 04 §5.1).
 *
 * The first routes on the platform that are actually gated by `authorize`, and
 * a deliberate demonstration of the pattern every business module will copy:
 *
 *     authenticate()  →  authorize(PERMISSIONS.X)  →  validate(schema)  →  handler
 *
 * Note what is NOT here: no `feature` option. Roles and permissions are part of
 * every edition — a clinic on the cheapest plan still needs to manage its own
 * staff. Layer 1 applies to *modules you buy*, not to the platform itself.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./rbac.controller.js";
import {
  assignRoleSchema,
  createRoleSchema,
  idParamSchema,
  setRolePermissionsSchema,
  userRoleParamSchema,
} from "./rbac.schema.js";

export function rbacRouter(): Router {
  const router = Router();

  // The catalog itself — read-only, and needed by the role editor UI.
  router.get(
    "/permissions",
    authenticate(),
    authorize(PERMISSIONS.PERMISSION_VIEW),
    asyncHandler(controller.listPermissions),
  );

  router.get(
    "/roles",
    authenticate(),
    authorize(PERMISSIONS.ROLE_MANAGE),
    asyncHandler(controller.listRoles),
  );

  router.get(
    "/roles/:id",
    authenticate(),
    authorize(PERMISSIONS.ROLE_MANAGE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getRole),
  );

  router.post(
    "/roles",
    authenticate(),
    authorize(PERMISSIONS.ROLE_MANAGE),
    validate(createRoleSchema),
    asyncHandler(controller.createRole),
  );

  router.put(
    "/roles/:id/permissions",
    authenticate(),
    authorize(PERMISSIONS.ROLE_MANAGE),
    validate(idParamSchema, "params"),
    validate(setRolePermissionsSchema),
    asyncHandler(controller.setRolePermissions),
  );

  router.delete(
    "/roles/:id",
    authenticate(),
    authorize(PERMISSIONS.ROLE_MANAGE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.deleteRole),
  );

  // Granting a role is a privilege ESCALATION path, so it has its own permission
  // (`user:assign-role`) separate from `role:manage`. A user who can edit roles
  // but not assign them cannot quietly promote themselves.
  router.post(
    "/users/:id/roles",
    authenticate(),
    authorize(PERMISSIONS.USER_ASSIGN_ROLE),
    validate(idParamSchema, "params"),
    validate(assignRoleSchema),
    asyncHandler(controller.assignRole),
  );

  router.delete(
    "/users/:id/roles/:roleCode",
    authenticate(),
    authorize(PERMISSIONS.USER_ASSIGN_ROLE),
    validate(userRoleParamSchema, "params"),
    asyncHandler(controller.revokeRole),
  );

  return router;
}
