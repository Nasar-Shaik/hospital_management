/**
 * Encounter controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import { AppError } from "../../core/errors/appError.js";
import * as encounters from "./encounter.service.js";
import type {
  AdmitBody,
  ListEncountersQuery,
  ListInpatientsQuery,
  StartEncounterBody,
  TransferBody,
  VisitSummaryBody,
} from "./encounter.schema.js";
import { ok } from "../../core/http/respond.js";

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
   * `?date=2026-07-16` — the front desk's register for one day, passed through as the DAY it is.
   *
   * Which instants that day covers depends on the zone the site's clock runs in, and resolving a
   * branch is an async domain lookup rather than HTTP work, so the service owns it (Doc 09 §11).
   * This used to call `dayRangeInZone(date, env.DEFAULT_TIMEZONE)` here — see risk register D2.
   */
  const { items, total } = await encounters.listEncountersWithIdentity({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.doctorId ? { doctorId: query.doctorId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.queued ? { queuedOnly: true } : {}),
    ...(query.date ? { date: query.date } : {}),
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

/** The doctor records the OP visit summary (diagnosis / advice) for the OPD slip. */
export const recordVisitSummary: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as VisitSummaryBody;
  ok(res, await encounters.recordVisitSummary(id, body));
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

/**
 * Admits the patient. 201 — this CREATES an encounter (the inpatient one).
 *
 * Returns both halves, because the caller needs the new IP encounter's id and the screen
 * needs to show that the OP visit is over. Two encounters, one episode (ADR-0013 §4).
 */
export const admitPatient: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await encounters.admitPatient(id, req.body as AdmitBody), 201);
};

/** Hands the patient to another doctor. A handover, not an edit — see the service. */
export const transferDoctor: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as TransferBody;
  ok(res, await encounters.transferDoctor(id, body.doctorId, body.reason));
};

/**
 * Everyone in a bed right now, one page at a time.
 *
 * ── THE `total` WAS COMPUTED AND THROWN AWAY ────────────────────────────────
 * The repository has always returned `{ items, total }` and this controller used to discard the
 * second half, send a bare array, and hard-code `{ limit: 100, skip: 0 }`. A hospital with more
 * than a hundred open stays therefore saw a hundred, with nothing in the response to say so —
 * admitted patients silently absent from the ward round, which is the worst shape a list bug can
 * take. `meta` now carries the same four fields every other list on this API sends.
 */
export const listInpatients: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListInpatientsQuery;

  // Identity is resolved SERVER-side (see `listInpatientsWithIdentity`): the ward list names the
  // patient in the bed, rather than leaving every client to reconstruct it from a patient page.
  const { items, total } = await encounters.listInpatientsWithIdentity({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.ward ? { ward: query.ward } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};
