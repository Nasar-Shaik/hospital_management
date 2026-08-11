/**
 * Consultation note controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as consultations from "./consultation.service.js";
import type { SaveConsultationBody } from "./consultation.schema.js";
import { ok } from "../../core/http/respond.js";

export const getConsultation: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  // A visit with no note yet is `null`, not a 404 — the editor opens empty, it does not error.
  ok(res, (await consultations.getConsultation(id)) ?? null);
};

export const saveConsultation: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await consultations.saveConsultation(id, req.body as SaveConsultationBody));
};
