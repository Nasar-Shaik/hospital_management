/**
 * Admission controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as admissions from "./admission.service.js";
import type { AddNoteBody, DischargeBody, ListNotesQuery } from "./admission.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const addNote: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as AddNoteBody;
  ok(res, await admissions.addNote({ encounterId: id, text: body.text }), 201);
};

export const listNotes: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const query = req.query as unknown as ListNotesQuery;
  ok(res, await admissions.notesFor(id, query.type));
};

/**
 * Discharge: writes the summary AND ends the stay. 201 — it creates a document, and the
 * document is the point.
 */
export const discharge: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as DischargeBody;

  ok(
    res,
    await admissions.dischargeWithSummary({
      encounterId: id,
      text: body.text,
      ...(body.diagnosis ? { diagnosis: body.diagnosis } : {}),
      ...(body.advice ? { advice: body.advice } : {}),
      // Parsed at the EDGE. A service that takes a string and parses it is a service with
      // a date-format bug waiting in it.
      ...(body.followUpOn ? { followUpOn: new Date(`${body.followUpOn}T00:00:00.000Z`) } : {}),
    }),
    201,
  );
};
