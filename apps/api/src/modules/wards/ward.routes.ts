/**
 * Ward & bed routes (Module B4).
 *
 * ── GATED ON `module.ops.ipd` ───────────────────────────────────────────────
 * A clinic and a diagnostic centre have no beds, and their editions do not carry the IPD flag.
 * A bed inventory is meaningless without a ward, so the whole router sits behind it — a clinic
 * gets "not in your edition" (HMS-PLAN-002), which names the truth, rather than a permission
 * error no role edit could fix. Same gate as the admission routes.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READS (`emr:read`)  — list wards and beds. Held by everyone clinical, because the admit
 *                       screen (a doctor) and the ward (a nurse) both need to see the free beds.
 *                       Deliberately not `bed:manage`: choosing a bed is not configuring one.
 * WRITES (`bed:manage`) — create/edit a ward, add/block a bed. The administrative act of
 *                       configuring the estate; TENANT_ADMIN holds it, the ward staff do not.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./ward.controller.js";
import {
  createWardSchema,
  updateWardSchema,
  createBedSchema,
  updateBedSchema,
  listBedsQuerySchema,
  idParamSchema,
} from "./ward.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_IPD } as const;

export function wardRouter(): Router {
  const router = Router();

  router.get(
    "/wards",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    asyncHandler(controller.listWards),
  );

  router.post(
    "/wards",
    authenticate(),
    authorize(PERMISSIONS.BED_MANAGE, FEATURE),
    validate(createWardSchema),
    asyncHandler(controller.createWard),
  );

  router.patch(
    "/wards/:id",
    authenticate(),
    authorize(PERMISSIONS.BED_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateWardSchema),
    asyncHandler(controller.updateWard),
  );

  router.get(
    "/beds",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(listBedsQuerySchema, "query"),
    asyncHandler(controller.listBeds),
  );

  router.post(
    "/beds",
    authenticate(),
    authorize(PERMISSIONS.BED_MANAGE, FEATURE),
    validate(createBedSchema),
    asyncHandler(controller.createBed),
  );

  router.patch(
    "/beds/:id",
    authenticate(),
    authorize(PERMISSIONS.BED_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateBedSchema),
    asyncHandler(controller.updateBed),
  );

  return router;
}
