/**
 * Theatre & OT-booking controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as ot from "./theatre.service.js";
import type {
  CreateTheatreBody,
  UpdateTheatreBody,
  CreateBookingBody,
  OperativeNoteBody,
  TransitionBookingBody,
  ListBookingsQuery,
} from "./theatre.schema.js";
import { ok } from "../../core/http/respond.js";

/**
 * The window a board query means when it names none.
 *
 * A BOARD with no dates means "today" — the surgical list, which is the only useful default for a
 * screen showing a day. A CHART query (one that names a patient) means "all of it", so it gets no
 * window at all: silently clipping a patient's surgical history to today would hide every operation
 * they have ever had, and look exactly like a patient who has never been operated on.
 */
function windowFor(query: ListBookingsQuery): { from?: Date; to?: Date } {
  if (query.from && query.to) return { from: query.from, to: query.to };
  if (query.patientId && !query.from) return {};
  const base = query.from ?? new Date();
  const from = new Date(base);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

/* ── Theatres ── */

export const listTheatres: RequestHandler = async (_req, res) => {
  ok(res, await ot.listTheatres());
};

export const createTheatre: RequestHandler = async (req, res) => {
  ok(res, await ot.createTheatre(req.body as CreateTheatreBody), 201);
};

export const updateTheatre: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await ot.updateTheatre(id, req.body as UpdateTheatreBody));
};

/* ── OT bookings ── */

export const listBookings: RequestHandler = async (req, res) => {
  const query = req.query as ListBookingsQuery;
  const { from, to } = windowFor(query);
  ok(
    res,
    await ot.listBookings({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.theatreId ? { theatreId: query.theatreId } : {}),
      ...(query.status ? { status: query.status } : {}),
    }),
  );
};

export const createBooking: RequestHandler = async (req, res) => {
  ok(res, await ot.createBooking(req.body as CreateBookingBody), 201);
};

export const transitionBooking: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await ot.transitionBooking(id, req.body as TransitionBookingBody));
};

export const recordOperativeNote: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as OperativeNoteBody;
  ok(
    res,
    await ot.recordOperativeNote(id, {
      procedurePerformed: body.procedurePerformed,
      surgeonId: body.surgeonId,
      performedAt: body.performedAt,
      ...(body.findings ? { findings: body.findings } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    }),
    201,
  );
};
