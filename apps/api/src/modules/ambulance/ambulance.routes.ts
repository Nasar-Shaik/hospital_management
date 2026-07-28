/**
 * Ambulance & trip routes (Module B6).
 *
 * ── GATED ON `module.support.ambulance` ─────────────────────────────────────
 * Only a hospital that runs a fleet offers this; the editions that carry the ambulance flag switch
 * it on. A clinic gets "not in your edition" (HMS-PLAN-002), which names the truth, rather than a
 * permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * BOARD + FLEET LIST (`ambulance:dispatch`) — the dispatch board and the vehicle list it picks from.
 *                           This is the desk's daily screen, so the READ that feeds dispatching is
 *                           the dispatch permission itself (branch-scoped).
 * REGISTRY WRITE (`ambulance:manage`) — add/edit a vehicle. The fleet-management permission; a pure
 *                           manager also holds `dispatch` to see the list they edit, and TENANT_ADMIN
 *                           holds both.
 * DISPATCH (`ambulance:dispatch`)   — send a vehicle out, move a trip along its lifecycle.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./ambulance.controller.js";
import {
  createAmbulanceSchema,
  updateAmbulanceSchema,
  createTripSchema,
  transitionTripSchema,
  listTripsQuerySchema,
  idParamSchema,
} from "./ambulance.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.SUPPORT_AMBULANCE } as const;

export function ambulanceRouter(): Router {
  const router = Router();

  /* ── Fleet registry ── */
  router.get(
    "/ambulances",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_DISPATCH, FEATURE),
    asyncHandler(controller.listAmbulances),
  );

  router.post(
    "/ambulances",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_MANAGE, FEATURE),
    validate(createAmbulanceSchema),
    asyncHandler(controller.createAmbulance),
  );

  router.patch(
    "/ambulances/:id",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateAmbulanceSchema),
    asyncHandler(controller.updateAmbulance),
  );

  /* ── Dispatch board ── */
  router.get(
    "/ambulance-trips",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_DISPATCH, FEATURE),
    validate(listTripsQuerySchema, "query"),
    asyncHandler(controller.listTrips),
  );

  router.post(
    "/ambulance-trips",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_DISPATCH, FEATURE),
    validate(createTripSchema),
    asyncHandler(controller.createTrip),
  );

  router.post(
    "/ambulance-trips/:id/transition",
    authenticate(),
    authorize(PERMISSIONS.AMBULANCE_DISPATCH, FEATURE),
    validate(idParamSchema, "params"),
    validate(transitionTripSchema),
    asyncHandler(controller.transitionTrip),
  );

  return router;
}
