/**
 * Mortuary routes (Module support.mortuary) — the body custody register.
 *
 * ── GATED ON `module.support.mortuary` ──────────────────────────────────────
 * A mortuary is a hospital-edition feature; a clinic that has none gets "not in your edition"
 * rather than an empty register.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * REGISTER (`mortuary:manage`)  — receive a body and read the register. Ward/mortuary custody.
 * RELEASE  (`mortuary:release`) — hand a body over. The controlled act: for a medico-legal case the
 *                                 service refuses it without a police/magistrate clearance.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./mortuary.controller.js";
import {
  receiveBodySchema,
  releaseBodySchema,
  listQuerySchema,
  idParamSchema,
  encounterParamSchema,
} from "./mortuary.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.SUPPORT_MORTUARY } as const;

export function mortuaryRouter(): Router {
  const router = Router();

  router.get(
    "/mortuary/register",
    authenticate(),
    authorize(PERMISSIONS.MORTUARY_MANAGE, FEATURE),
    validate(listQuerySchema, "query"),
    asyncHandler(controller.listRegister),
  );

  router.get(
    "/mortuary/for-encounter/:encounterId",
    authenticate(),
    authorize(PERMISSIONS.MORTUARY_MANAGE, FEATURE),
    validate(encounterParamSchema, "params"),
    asyncHandler(controller.getForEncounter),
  );

  router.post(
    "/mortuary/register",
    authenticate(),
    authorize(PERMISSIONS.MORTUARY_MANAGE, FEATURE),
    validate(receiveBodySchema),
    asyncHandler(controller.receiveBody),
  );

  router.post(
    "/mortuary/register/:id/release",
    authenticate(),
    authorize(PERMISSIONS.MORTUARY_RELEASE, FEATURE),
    validate(idParamSchema, "params"),
    validate(releaseBodySchema),
    asyncHandler(controller.releaseBody),
  );

  return router;
}
