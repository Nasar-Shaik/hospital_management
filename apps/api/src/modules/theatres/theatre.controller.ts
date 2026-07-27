/**
 * Theatre & OT-booking controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as ot from "./theatre.service.js";
import type {
  CreateTheatreBody,
  UpdateTheatreBody,
  CreateBookingBody,
  TransitionBookingBody,
  ListBookingsQuery,
} from "./theatre.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/** The local day, in server time, for a board query with no explicit window. */
function dayWindow(query: ListBookingsQuery): { from: Date; to: Date } {
  if (query.from && query.to) return { from: query.from, to: query.to };
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
  const { from, to } = dayWindow(query);
  ok(
    res,
    await ot.listBookings({
      from,
      to,
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
