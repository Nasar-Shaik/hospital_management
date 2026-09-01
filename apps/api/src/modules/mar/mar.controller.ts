/**
 * MAR controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as mar from "./mar.service.js";
import type { RecordAdministrationBody, ScheduleQuery } from "./mar.schema.js";
import { ok } from "../../core/http/respond.js";

export const listAdministrations: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await mar.listAdministrations(id));
};

export const getSchedule: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { date } = req.query as ScheduleQuery;
  ok(res, await mar.getSchedule(id, date));
};

export const recordAdministration: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as RecordAdministrationBody;
  ok(
    res,
    await mar.recordAdministration(id, {
      prescriptionId: body.prescriptionId,
      drugCode: body.drugCode,
      ...(body.lineIndex !== undefined ? { lineIndex: body.lineIndex } : {}),
      status: body.status,
      // The schema coerces to a Date; the service takes an ISO string.
      ...(body.scheduledFor ? { scheduledFor: body.scheduledFor.toISOString() } : {}),
      ...(body.administeredAt ? { administeredAt: body.administeredAt.toISOString() } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.note ? { note: body.note } : {}),
    }),
    201,
  );
};
