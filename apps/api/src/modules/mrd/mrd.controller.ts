/**
 * MRD controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as mrd from "./mrd.service.js";
import type {
  CreateIcdBody,
  UpdateIcdBody,
  ListIcdQuery,
  SaveCodingBody,
  RegisterQuery,
} from "./mrd.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/* ── ICD master ────────────────────────────────────────────────────────────── */

export const listIcd: RequestHandler = async (req, res) => {
  const { search, includeInactive } = req.query as ListIcdQuery;
  ok(res, await mrd.listIcd(search, Boolean(includeInactive)));
};

export const createIcd: RequestHandler = async (req, res) => {
  ok(res, await mrd.createIcd(req.body as CreateIcdBody), 201);
};

export const updateIcd: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await mrd.updateIcd(id, req.body as UpdateIcdBody));
};

/* ── encounter coding ──────────────────────────────────────────────────────── */

export const getCoding: RequestHandler = async (req, res) => {
  const { encounterId } = req.params as { encounterId: string };
  const coding = await mrd.getCoding(encounterId);
  ok(res, coding ?? null);
};

export const saveCoding: RequestHandler = async (req, res) => {
  const { encounterId } = req.params as { encounterId: string };
  const { codes } = req.body as SaveCodingBody;
  ok(res, await mrd.saveCoding(encounterId, codes));
};

/* ── disease register ──────────────────────────────────────────────────────── */

export const diseaseRegister: RequestHandler = async (req, res) => {
  // `validate` has already coerced from/to to Dates; the ParsedQs shape needs the `unknown` hop.
  const { from, to } = req.query as unknown as RegisterQuery;
  ok(res, await mrd.diseaseRegister(from, to));
};
