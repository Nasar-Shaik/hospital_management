/**
 * Admission controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as admissions from "./admission.service.js";
import { bedBoard } from "./bedBoard.js";
import type {
  AddNoteBody,
  AddNursingNoteBody,
  DischargeBody,
  OutcomeBody,
  ListNotesQuery,
  TransferBedBody,
} from "./admission.schema.js";
import { ok } from "../../core/http/respond.js";

/** The free-and-occupied bed board — the inventory joined to who is actually admitted. */
export const getBedBoard: RequestHandler = async (_req, res) => {
  ok(res, await bedBoard());
};

export const addNote: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as AddNoteBody;
  ok(res, await admissions.addNote({ encounterId: id, text: body.text }), 201);
};

export const addNursingNote: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as AddNursingNoteBody;
  ok(res, await admissions.addNursingNote({ encounterId: id, text: body.text }), 201);
};

export const listNotes: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const query = req.query as unknown as ListNotesQuery;
  ok(res, await admissions.notesFor(id, query.type));
};

/** Moves an admitted patient to another bed, recording the reason on the ward round. */
export const transferBed: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as TransferBedBody;
  ok(
    res,
    await admissions.transferBed({
      encounterId: id,
      ...(body.bedId ? { bedId: body.bedId } : {}),
      ...(body.ward ? { ward: body.ward } : {}),
      ...(body.bedCode ? { bedCode: body.bedCode } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    }),
  );
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

/**
 * Record a non-routine ending — LAMA, absconded, or a death. Writes the outcome note AND
 * ends the stay with its true disposition. 201: like discharge, it creates the document
 * that IS the record of what happened.
 */
export const recordOutcome: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as OutcomeBody;

  ok(
    res,
    await admissions.recordOutcome({ encounterId: id, outcome: body.outcome, text: body.text }),
    201,
  );
};
