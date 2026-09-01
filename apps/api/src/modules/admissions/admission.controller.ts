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
  MedicationRoundQuery,
  OutcomeBody,
  ListNotesQuery,
  WorklistQuery,
  TransferBedBody,
} from "./admission.schema.js";
import { wardWorklist } from "./worklist.js";
import { medicationRound } from "./medicationRound.js";
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

/** One page of the ward, with allergy and due-dose state resolved server-side. */
export const getWorklist: RequestHandler = async (req, res) => {
  const query = req.query as unknown as WorklistQuery;
  const { items, total } = await wardWorklist({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.ward ? { ward: query.ward } : {}),
  });
  ok(res, items, 200, { page: query.page, limit: query.limit, total });
};

/**
 * One page of the medication round (M3-S5B) — the ward's doses for one clinical day.
 *
 * ── THE RESOLVED DAY IS NOT ECHOED, AND THAT IS DELIBERATE ──────────────────
 * The service resolves `date` in the ward's zone when the caller names none, and it would be easy
 * to hand that back — in `meta` (the paging envelope every list shares, which must not grow a
 * field one endpoint sets) or in a header (which CORS does not expose, so a browser client could
 * not read it). Either would be a channel nobody consumes, and an unread contract is worse than
 * none: it reads as a guarantee. The mobile round names its day explicitly, computed from the
 * BRANCH's zone, so it already knows which one it asked for.
 */
export const getMedicationRound: RequestHandler = async (req, res) => {
  const query = req.query as unknown as MedicationRoundQuery;
  const { items, total } = await medicationRound({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.ward ? { ward: query.ward } : {}),
    ...(query.date ? { date: query.date } : {}),
  });
  ok(res, items, 200, { page: query.page, limit: query.limit, total });
};
