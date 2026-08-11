/**
 * Department routes (Modules B2/B3).
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Every edition has departments — a clinic has an OPD and a lab has sections. Like `branches`, the
 * entity is part of every edition, so the router is not feature-gated.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`patient:read`)  — list departments. Deliberately the BROADEST operational read: reception
 *                          routes a patient into a department at registration, and every clinical
 *                          role reads the queue board — all of them hold `patient:read`, none of
 *                          them holds `department:manage`. A department list is org structure, not
 *                          PHI, so the wide read discloses nothing sensitive.
 * WRITE (`department:manage`) — create/edit a department, set its parent. The administrative act of
 *                          shaping the org chart; TENANT_ADMIN holds it, the ward staff do not.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./department.controller.js";
import { department } from "./department.contract.js";
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  idParamSchema,
} from "./department.schema.js";

export function departmentRouter(): Router {
  const router = Router();

  router.get(
    "/departments",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_READ),
    responds(department.array()),
    asyncHandler(controller.list),
  );

  router.post(
    "/departments",
    authenticate(),
    authorize(PERMISSIONS.DEPARTMENT_MANAGE),
    validate(createDepartmentSchema),
    responds(department, { status: 201 }),
    asyncHandler(controller.create),
  );

  router.patch(
    "/departments/:id",
    authenticate(),
    authorize(PERMISSIONS.DEPARTMENT_MANAGE),
    validate(idParamSchema, "params"),
    validate(updateDepartmentSchema),
    responds(department),
    asyncHandler(controller.update),
  );

  return router;
}
