/**
 * Vitals controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as vitals from "./vitals.service.js";
import type { ListPatientVitalsQuery, RecordVitalsBody } from "./vitals.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const record: RequestHandler = async (req, res) => {
  const { encounterId } = req.params as { encounterId: string };
  const body = req.body as RecordVitalsBody;
  ok(res, await vitals.recordVitals({ encounterId, ...body }), 201);
};

export const listForEncounter: RequestHandler = async (req, res) => {
  const { encounterId } = req.params as { encounterId: string };
  ok(res, await vitals.listForEncounter(encounterId));
};

export const listForPatient: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const { limit } = req.query as ListPatientVitalsQuery;
  ok(res, await vitals.listForPatient(patientId, limit));
};
