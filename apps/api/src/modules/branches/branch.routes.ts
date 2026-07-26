/**
 * Branch routes (ADR-0015).
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Every hospital has at least one branch (its Main Branch), so the entity is part of every edition.
 * What an edition CAPS is how many branches a tenant may create — enforced in the service against
 * the master limit, not by gating the route.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `GET /me/branches` — the switcher. Self-service: authenticated only, no permission, like
 *                      `/auth/me`. Every signed-in person may see the sites they work in. It returns
 *                      only the caller's OWN allowed branches, so it discloses nothing wider.
 * `branch:manage`   — the admin surface: list every branch, create one, edit one. A tenant-scoped
 *                      administrative capability (TENANT_ADMIN holds it).
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./branch.controller.js";
import { branchIdParamSchema, createBranchSchema, updateBranchSchema } from "./branch.schema.js";

export function branchRouter(): Router {
  const router = Router();

  // The switcher — self-service, no permission (see the header).
  router.get("/me/branches", authenticate(), asyncHandler(controller.listMine));

  router.get(
    "/branches",
    authenticate(),
    authorize(PERMISSIONS.BRANCH_MANAGE),
    asyncHandler(controller.list),
  );

  router.post(
    "/branches",
    authenticate(),
    authorize(PERMISSIONS.BRANCH_MANAGE),
    validate(createBranchSchema),
    asyncHandler(controller.create),
  );

  router.patch(
    "/branches/:id",
    authenticate(),
    authorize(PERMISSIONS.BRANCH_MANAGE),
    validate(branchIdParamSchema, "params"),
    validate(updateBranchSchema),
    asyncHandler(controller.update),
  );

  return router;
}
