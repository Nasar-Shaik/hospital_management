/**
 * Appointment routes (Doc 02 E1 pages: Booking, Doctor's Day, Queue).
 *
 * ── THE FIRST FEATURE-GATED MODULE IN THE CODEBASE ───────────────────────────
 * Every route here carries `{ feature: FEATURE_FLAGS.OPS_APPOINTMENTS }` — layer 1
 * of the three-layer chain (ADR-0010), which until now had no route exercising it.
 *
 * Patients deliberately carry NO flag (every edition registers patients). Scheduling
 * is different: a standalone diagnostic lab or a pharmacy-only tenant has no
 * appointment book, and charging them for one they cannot use — or worse, showing
 * them a half-working screen — is how an edition boundary rots. A hospital that
 * never bought scheduling gets `HMS-PLAN-002` ("not in your edition"), which sends
 * their admin to sales, not on a hunt through the role editor for a permission that
 * can never help them. That distinction is the whole reason layer 1 runs first.
 *
 * ── THE PERMISSION SPLIT ─────────────────────────────────────────────────────
 * `appointment:read` / `create` / `update` / `cancel` are all `branch`-scoped.
 * Cancel is separate from update on purpose: rescheduling inconveniences a patient,
 * cancelling removes them from the doctor's list entirely, and the second is the one
 * that generates complaints. Managing a doctor's HOURS is `doctor:manage` — roster
 * administration, not front-desk work.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./appointment.controller.js";
import {
  availabilityQuerySchema,
  bookAppointmentSchema,
  cancelAppointmentSchema,
  doctorIdParamSchema,
  idParamSchema,
  listAppointmentsQuerySchema,
  noShowSchema,
  rescheduleAppointmentSchema,
  setScheduleSchema,
  setAvailabilitySchema,
  addLeaveSchema,
} from "./appointment.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_APPOINTMENTS } as const;

export function appointmentRouter(): Router {
  const router = Router();

  /**
   * What is still free? Declared BEFORE `/appointments/:id` so `availability` is
   * not swallowed as an id. Gated on `appointment:read` — the response reveals a
   * doctor's working pattern, which is roster information, not public.
   */
  router.get(
    "/appointments/availability",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(availabilityQuerySchema, "query"),
    asyncHandler(controller.getAvailability),
  );

  router.get(
    "/appointments",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(listAppointmentsQuerySchema, "query"),
    asyncHandler(controller.listAppointments),
  );

  router.get(
    "/appointments/:id",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getAppointment),
  );

  router.post(
    "/appointments",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_CREATE, FEATURE),
    validate(bookAppointmentSchema),
    asyncHandler(controller.bookAppointment),
  );

  /* ── lifecycle (STATE_MACHINE_CATALOG §1) ── */

  router.post(
    "/appointments/:id/confirm",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.confirmAppointment),
  );

  router.post(
    "/appointments/:id/check-in",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.checkIn),
  );

  router.post(
    "/appointments/:id/start",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.startConsultation),
  );

  router.post(
    "/appointments/:id/complete",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.completeAppointment),
  );

  router.post(
    "/appointments/:id/reschedule",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(rescheduleAppointmentSchema),
    asyncHandler(controller.rescheduleAppointment),
  );

  router.post(
    "/appointments/:id/no-show",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(noShowSchema),
    asyncHandler(controller.markNoShow),
  );

  // Its own permission — see the header.
  router.post(
    "/appointments/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_CANCEL, FEATURE),
    validate(idParamSchema, "params"),
    validate(cancelAppointmentSchema),
    asyncHandler(controller.cancelAppointment),
  );

  /* ── doctor schedules (Doc 02 D2) — roster administration ── */

  router.get(
    "/doctors/:doctorId/schedule",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(doctorIdParamSchema, "params"),
    asyncHandler(controller.getDoctorSchedules),
  );

  router.put(
    "/doctors/schedule",
    authenticate(),
    authorize(PERMISSIONS.DOCTOR_MANAGE, FEATURE),
    validate(setScheduleSchema),
    asyncHandler(controller.setDoctorSchedule),
  );

  router.delete(
    "/doctors/schedule/:id",
    authenticate(),
    authorize(PERMISSIONS.DOCTOR_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.removeDoctorSchedule),
  );

  /* ── doctor availability (session roster) & leave (Doc 02 D2) ── */

  router.get(
    "/doctors/:doctorId/availability",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(doctorIdParamSchema, "params"),
    asyncHandler(controller.getDoctorAvailability),
  );

  router.put(
    "/doctors/availability",
    authenticate(),
    authorize(PERMISSIONS.DOCTOR_MANAGE, FEATURE),
    validate(setAvailabilitySchema),
    asyncHandler(controller.setDoctorAvailability),
  );

  router.get(
    "/doctors/:doctorId/leave",
    authenticate(),
    authorize(PERMISSIONS.APPOINTMENT_READ, FEATURE),
    validate(doctorIdParamSchema, "params"),
    asyncHandler(controller.getDoctorLeave),
  );

  router.post(
    "/doctors/leave",
    authenticate(),
    authorize(PERMISSIONS.DOCTOR_MANAGE, FEATURE),
    validate(addLeaveSchema),
    asyncHandler(controller.addDoctorLeave),
  );

  router.delete(
    "/doctors/leave/:id",
    authenticate(),
    authorize(PERMISSIONS.DOCTOR_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.removeDoctorLeave),
  );

  return router;
}
