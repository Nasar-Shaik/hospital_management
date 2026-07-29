/**
 * Medico-legal controller — HTTP only (Doc 09 §11). Coerced dates default at the edge.
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as medicolegal from "./medicolegal.service.js";
import type {
  RecordConsentBody,
  WithdrawConsentBody,
  RecordDeathBody,
  PatientQuery,
  EncounterQuery,
} from "./medicolegal.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/* ── consent ─────────────────────────────────────────────────────────────── */

export const listConsents: RequestHandler = async (req, res) => {
  const { patientId } = req.query as PatientQuery;
  ok(res, await medicolegal.listConsents(patientId));
};

export const recordConsent: RequestHandler = async (req, res) => {
  const body = req.body as RecordConsentBody;
  ok(res, await medicolegal.recordConsent({ ...body, signedAt: body.signedAt ?? new Date() }), 201);
};

export const withdrawConsent: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as WithdrawConsentBody;
  ok(res, await medicolegal.withdrawConsent(id, reason));
};

/* ── death record ────────────────────────────────────────────────────────── */

export const getDeathRecord: RequestHandler = async (req, res) => {
  const { encounterId } = req.query as EncounterQuery;
  const record = await medicolegal.getDeathRecordForEncounter(encounterId);
  ok(res, record ?? null);
};

export const recordDeath: RequestHandler = async (req, res) => {
  ok(res, await medicolegal.recordDeath(req.body as RecordDeathBody), 201);
};
