/**
 * Allergy controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as allergies from "./allergy.service.js";
import type { RecordAllergyBody, RefuteAllergyBody } from "./allergy.schema.js";
import { ok } from "../../core/http/respond.js";

export const record: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  const body = req.body as RecordAllergyBody;
  ok(
    res,
    await allergies.recordAllergy({
      patientId,
      allergen: body.allergen,
      severity: body.severity,
      ...(body.reaction ? { reaction: body.reaction } : {}),
    }),
    201,
  );
};

export const list: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await allergies.listAllergies(patientId));
};

export const refute: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as RefuteAllergyBody;
  ok(res, await allergies.refuteAllergy(id, body.reason));
};
