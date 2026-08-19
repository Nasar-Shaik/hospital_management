/**
 * Theatre & OT-booking routes (Module B5).
 *
 * ── GATED ON `module.clinical.ot` ───────────────────────────────────────────
 * Only a surgical hospital has operating theatres, and only the editions that carry the OT flag
 * offer this. A clinic gets "not in your edition" (HMS-PLAN-002), which names the truth, rather than
 * a permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READS (`emr:read`)      — the theatre list and the OT board. Every clinical reader (surgeon,
 *                           nurse, anaesthetist) needs to see today's schedule.
 * REGISTRY (`facility:manage`) — create/edit a theatre. The catalogue permission whose own
 *                           description is "buildings, floors, theatres, ICUs".
 * SCHEDULING (`ot:schedule`)   — book a procedure, move it along its lifecycle. The OT
 *                           coordinator's capability, distinct from configuring the room.
 * RECORD (`ot:record`)     — write the operation record. SEPARATE from scheduling on purpose: the
 *                           person who runs the list is not the person who states what was found
 *                           inside the patient. The surgeon holds it; the coordinator does not.
 *
 * ── WHY THE BOARD IS `emr:read` AND THAT IS NOT A "BROAD GRANT" ─────────────
 * A surgical list names a patient, their operation and their surgeon — it is the chart, arranged
 * by time. Everyone who reads it (surgeon, ward nurse, anaesthetist) already holds `emr:read` for
 * the same patients, so nothing is widened to make this screen work; the alternative — inventing
 * an "OT board read" that hands a logistics role a list of who is having what done today — would
 * be the broad grant, wearing a narrow name.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./theatre.controller.js";
import { otBooking, theatre } from "./theatre.contract.js";
import {
  createTheatreSchema,
  updateTheatreSchema,
  createBookingSchema,
  operativeNoteSchema,
  transitionBookingSchema,
  listBookingsQuerySchema,
  idParamSchema,
} from "./theatre.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_OT } as const;

export function theatreRouter(): Router {
  const router = Router();

  /* ── Theatre registry ── */
  router.get(
    "/theatres",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    responds(theatre.array()),
    asyncHandler(controller.listTheatres),
  );

  router.post(
    "/theatres",
    authenticate(),
    authorize(PERMISSIONS.FACILITY_MANAGE, FEATURE),
    validate(createTheatreSchema),
    responds(theatre, { status: 201 }),
    asyncHandler(controller.createTheatre),
  );

  router.patch(
    "/theatres/:id",
    authenticate(),
    authorize(PERMISSIONS.FACILITY_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateTheatreSchema),
    responds(theatre),
    asyncHandler(controller.updateTheatre),
  );

  /* ── OT schedule ── */
  router.get(
    "/ot-bookings",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(listBookingsQuerySchema, "query"),
    responds(otBooking.array()),
    asyncHandler(controller.listBookings),
  );

  router.post(
    "/ot-bookings",
    authenticate(),
    authorize(PERMISSIONS.OT_SCHEDULE, FEATURE),
    validate(createBookingSchema),
    responds(otBooking, { status: 201 }),
    asyncHandler(controller.createBooking),
  );

  router.post(
    "/ot-bookings/:id/transition",
    authenticate(),
    authorize(PERMISSIONS.OT_SCHEDULE, FEATURE),
    validate(idParamSchema, "params"),
    validate(transitionBookingSchema),
    responds(otBooking),
    asyncHandler(controller.transitionBooking),
  );

  /**
   * The operation record. `ot:record`, not `ot:schedule` — see the header. Written once; the
   * repository's conditional update is what enforces that, not this route.
   */
  router.post(
    "/ot-bookings/:id/operative-note",
    authenticate(),
    authorize(PERMISSIONS.OT_RECORD, FEATURE),
    validate(idParamSchema, "params"),
    validate(operativeNoteSchema),
    responds(otBooking, { status: 201 }),
    asyncHandler(controller.recordOperativeNote),
  );

  return router;
}
