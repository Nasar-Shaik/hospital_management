/**
 * Vitals controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as vitals from "./vitals.service.js";
import type { ListPatientVitalsQuery, RecordVitalsBody } from "./vitals.schema.js";
import { ok } from "../../core/http/respond.js";

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
