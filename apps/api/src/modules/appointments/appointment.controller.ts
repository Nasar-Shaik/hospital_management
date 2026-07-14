/**
 * Appointment controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import * as appointments from "./appointment.service.js";
import type {
  AvailabilityQuery,
  BookAppointmentBody,
  ListAppointmentsQuery,
  SetScheduleBody,
} from "./appointment.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

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
