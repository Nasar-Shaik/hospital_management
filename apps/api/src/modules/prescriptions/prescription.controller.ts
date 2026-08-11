/**
 * Prescription controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import { AppError } from "../../core/errors/appError.js";
import * as prescriptions from "./prescription.service.js";
import type {
  CreatePrescriptionBody,
  ListPrescriptionsQuery,
  UpdatePrescriptionBody,
} from "./prescription.schema.js";
import { ok } from "../../core/http/respond.js";

export const createPrescription: RequestHandler = async (req, res) => {
  const body = req.body as CreatePrescriptionBody;
  ok(res, await prescriptions.createPrescription(body), 201);
};

export const updatePrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await prescriptions.updateDraft(id, req.body as UpdatePrescriptionBody));
};

export const listPrescriptions: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListPrescriptionsQuery;

  const { items, total } = await prescriptions.listPrescriptions({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.encounterId ? { encounterId: query.encounterId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.current ? { currentOnly: true } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const rx = await prescriptions.getPrescription(id);
  if (!rx) throw new AppError("HMS-GEN-404", 404, "Prescription not found", { id });
  ok(res, rx);
};

/** The live safety screen the pad calls as the doctor composes — read-only, signs nothing. */
export const screenPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await prescriptions.screenPrescription(id));
};

/** The signature. After this the document is immutable — see `prescription.model.ts`. */
export const signPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { overrideReason?: string };
  ok(
    res,
    await prescriptions.signPrescription(id, {
      ...(body.overrideReason ? { overrideReason: body.overrideReason } : {}),
    }),
  );
};

export const cancelPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason: string };
  ok(res, await prescriptions.cancelPrescription(id, reason));
};

export const discardPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await prescriptions.discardPrescription(id));
};

/** A new DRAFT superseding a signed one. 201 — this creates a document. */
export const amendPrescription: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await prescriptions.amendPrescription(id), 201);
};
