/**
 * Encounter controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import { env } from "../../config/env.js";
import { dayRangeInZone } from "../../core/time/day.js";
import * as encounters from "./encounter.service.js";
import type { ListEncountersQuery, StartEncounterBody } from "./encounter.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/**
 * A patient arrives.
 *
 * Returns **200 with `resumed: true`** when the patient already had an open visit —
 * not a 409. The clerk is standing in front of a patient who came back from the lab;
 * the right answer is "here is their visit, token 42", not an error they will work
 * around by creating a duplicate patient record.
 *
 * 201 only when a genuinely new encounter was created.
 */
export const startEncounter: RequestHandler = async (req, res) => {
  const result = await encounters.startEncounter(req.body as StartEncounterBody);
  ok(res, result, result.resumed ? 200 : 201);
};

export const listEncounters: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListEncountersQuery;

  /**
   * `?date=2026-07-16` — the front desk's register for one day.
   *
   * Resolved in the HOSPITAL's timezone, not UTC and not the browser's: a clerk in
   * Kolkata asking for today means today there. See `core/time/day.ts` for why this
   * is not `new Date(query.date)`.
   */
  const day = query.date ? dayRangeInZone(query.date, env.DEFAULT_TIMEZONE) : undefined;

  const { items, total } = await encounters.listEncounters({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.doctorId ? { doctorId: query.doctorId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.queued ? { queuedOnly: true } : {}),
    ...(day ? { arrivedFrom: day.from, arrivedBefore: day.before } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getEncounter: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const encounter = await encounters.getEncounter(id);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });
  ok(res, encounter);
};

/**
 * The whole care story: every encounter in this episode, oldest first.
 *
 * This is what makes an admission "inherit" the OP consultation that preceded it —
 * the inheritance is a READ over the episode, not a copy into the admission
 * (ADR-0013 §4).
 */
export const getEpisodeTimeline: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.getEpisodeTimeline(id));
};

export const queuePatient: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.queuePatient(id));
};

export const startConsultation: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.startConsultation(id));
};

export const sendForInvestigations: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.sendForInvestigations(id));
};

export const closeEncounter: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason?: string };
  ok(res, await encounters.closeEncounter(id, reason));
};

export const cancelEncounter: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason: string };
  ok(res, await encounters.cancelEncounter(id, reason));
};

export const markLeftWithoutBeingSeen: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.markLeftWithoutBeingSeen(id));
};
