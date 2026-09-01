/**
 * Ambulance + trip controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as ambulance from "./ambulance.service.js";
import type {
  CreateAmbulanceBody,
  UpdateAmbulanceBody,
  CreateTripBody,
  TransitionTripBody,
  ListTripsQuery,
} from "./ambulance.schema.js";
import { ok } from "../../core/http/respond.js";

/** The local day, in server time, for a board query with no explicit window. */
function dayWindow(query: ListTripsQuery): { from: Date; to: Date } {
  if (query.from && query.to) return { from: query.from, to: query.to };
  const base = query.from ?? new Date();
  const from = new Date(base);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

/* ── Ambulances ── */

export const listAmbulances: RequestHandler = async (_req, res) => {
  ok(res, await ambulance.listAmbulances());
};

export const createAmbulance: RequestHandler = async (req, res) => {
  ok(res, await ambulance.createAmbulance(req.body as CreateAmbulanceBody), 201);
};

export const updateAmbulance: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await ambulance.updateAmbulance(id, req.body as UpdateAmbulanceBody));
};

/* ── Trips ── */

export const listTrips: RequestHandler = async (req, res) => {
  const query = req.query as ListTripsQuery;
  const { from, to } = dayWindow(query);
  ok(
    res,
    await ambulance.listTrips({
      from,
      to,
      ...(query.ambulanceId ? { ambulanceId: query.ambulanceId } : {}),
      ...(query.status ? { status: query.status } : {}),
    }),
  );
};

export const createTrip: RequestHandler = async (req, res) => {
  ok(res, await ambulance.createTrip(req.body as CreateTripBody), 201);
};

export const transitionTrip: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await ambulance.transitionTrip(id, req.body as TransitionTripBody));
};
