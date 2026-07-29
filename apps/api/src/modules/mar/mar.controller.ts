/**
 * MAR controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as mar from "./mar.service.js";
import type { RecordAdministrationBody } from "./mar.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const listAdministrations: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await mar.listAdministrations(id));
};

export const recordAdministration: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as RecordAdministrationBody;
  ok(
    res,
    await mar.recordAdministration(id, {
      prescriptionId: body.prescriptionId,
      drugCode: body.drugCode,
      status: body.status,
      // The schema coerces to a Date; the service takes an ISO string.
      ...(body.administeredAt ? { administeredAt: body.administeredAt.toISOString() } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.note ? { note: body.note } : {}),
    }),
    201,
  );
};
