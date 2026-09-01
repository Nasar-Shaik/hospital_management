/**
 * Appointment controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as appointments from "./appointment.service.js";
import type {
  AvailabilityQuery,
  BookAppointmentBody,
  ListAppointmentsQuery,
  SetScheduleBody,
  SetAvailabilityBody,
  AddLeaveBody,
  SetOwnAvailabilityBody,
  AddOwnLeaveBody,
} from "./appointment.schema.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { ok } from "../../core/http/respond.js";

export const bookAppointment: RequestHandler = async (req, res) => {
  ok(res, await appointments.bookAppointment(req.body as BookAppointmentBody), 201);
};

export const getAvailability: RequestHandler = async (req, res) => {
  const { doctorId, date } = req.query as unknown as AvailabilityQuery;
  ok(res, await appointments.getAvailability(doctorId, date));
};

export const listAppointments: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListAppointmentsQuery;
  const { appointments: rows, total } = await appointments.listAppointments(query);

  ok(res, rows, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getAppointment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await appointments.getAppointment(id));
};

export const confirmAppointment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await appointments.confirmAppointment(id));
};

export const cancelAppointment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason: string };
  ok(res, await appointments.cancelAppointment(id, reason));
};

export const rescheduleAppointment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { startAt, reason } = req.body as { startAt: Date; reason: string };
  ok(res, await appointments.rescheduleAppointment(id, startAt, reason), 201);
};

export const checkIn: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await appointments.checkInAppointment(id));
};

export const startConsultation: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await appointments.startConsultation(id));
};

export const completeAppointment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await appointments.completeAppointment(id));
};

export const markNoShow: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason?: string };
  ok(res, await appointments.markNoShow(id, reason));
};

export const setDoctorSchedule: RequestHandler = async (req, res) => {
  ok(res, await appointments.setDoctorSchedule(req.body as SetScheduleBody), 201);
};

export const getDoctorSchedules: RequestHandler = async (req, res) => {
  const { doctorId } = req.params as { doctorId: string };
  ok(res, await appointments.getDoctorSchedules(doctorId));
};

export const removeDoctorSchedule: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await appointments.removeDoctorSchedule(id);
  ok(res, { removed: true });
};

/* ── doctor availability (session roster) & leave (Doc 02 D2) ──────────────── */

export const getDoctorAvailability: RequestHandler = async (req, res) => {
  const { doctorId } = req.params as { doctorId: string };
  ok(res, await appointments.getDoctorAvailability(doctorId));
};

export const setDoctorAvailability: RequestHandler = async (req, res) => {
  ok(res, await appointments.setDoctorAvailability(req.body as SetAvailabilityBody));
};

export const getDoctorLeave: RequestHandler = async (req, res) => {
  const { doctorId } = req.params as { doctorId: string };
  ok(res, await appointments.getDoctorLeave(doctorId));
};

export const addDoctorLeave: RequestHandler = async (req, res) => {
  ok(res, await appointments.addDoctorLeave(req.body as AddLeaveBody), 201);
};

export const removeDoctorLeave: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await appointments.removeDoctorLeave(id);
  ok(res, { removed: true });
};

/* ── a doctor's own roster (`doctor:self-manage`) ──────────────────────────── */

/**
 * ── THE DOCTOR COMES FROM THE TOKEN, IN ALL THREE ──────────────────────────
 * `requireAuth(req).userId`, never `req.body`. A doctor IS a user holding the DOCTOR role — the
 * directory returns `{ id: user.id }` (`staff.service.listDoctors`) — so the authenticated subject
 * is the roster's owner with no lookup and nothing to spoof. The request bodies do not even have a
 * `doctorId` field to send (`appointment.schema.ts`), so a client that tries is rejected at
 * validation rather than silently ignored.
 */
export const setOwnAvailability: RequestHandler = async (req, res) => {
  const body = req.body as SetOwnAvailabilityBody;
  ok(res, await appointments.setDoctorAvailability({ ...body, doctorId: requireAuth(req).userId }));
};

export const addOwnLeave: RequestHandler = async (req, res) => {
  const body = req.body as AddOwnLeaveBody;
  ok(res, await appointments.addDoctorLeave({ ...body, doctorId: requireAuth(req).userId }), 201);
};

export const removeOwnLeave: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await appointments.removeOwnDoctorLeave(id, requireAuth(req).userId);
  ok(res, { removed: true });
};
