/**
 * Billing controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import { getEncounter } from "../encounters/index.js";
import * as billing from "./billing.service.js";
import type { ListInvoicesQuery, PostChargeBody, RecordPaymentBody } from "./billing.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/** The tariff — what this hospital charges for things. */
export const listServices: RequestHandler = async (req, res) => {
  const { category } = req.query as { category?: never };
  ok(res, await billing.listServices(category));
};

/**
 * The running bill for a visit.
 *
 * This is the endpoint every login uses — reception, pharmacy, the cashier, the
 * doctor. One bill per visit, assembled from the charge ledger, correct for a
 * government hospital (every line ₹0) and a private one through the same code.
 */
export const getBill: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };

  const encounter = await getEncounter(id);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

  ok(res, await billing.getRunningBill(id));
};

/** Manual charge — the desk adds something the system did not raise for itself. */
export const postCharge: RequestHandler = async (req, res) => {
  const body = req.body as PostChargeBody;

  const encounter = await getEncounter(body.encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id: body.encounterId });
  }

  const charge = await billing.postCharge({
    encounterId: encounter.id,
    // From the ENCOUNTER, never the request body — a caller who could name the patient
    // could bill somebody else for this.
    patientId: encounter.patientId,
    episodeId: encounter.episodeId,
    code: body.code,
    category: body.category,
    quantity: body.quantity,
    source: "manual",
    ...(body.description ? { description: body.description } : {}),
    ...(body.unitPrice !== undefined ? { unitPrice: body.unitPrice } : {}),
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
  });

  ok(res, charge, 201);
};

export const voidCharge: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason: string };
  ok(res, await billing.voidCharge(id, reason));
};

/** Freezes the bill and assigns its number. After this the lines cannot move. */
export const finalizeBill: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.finalizeInvoice(id));
};

export const listInvoices: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListInvoicesQuery;

  const { items, total } = await billing.listInvoices({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getInvoice: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const invoice = await billing.getInvoice(id);
  if (!invoice) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id });
  ok(res, invoice);
};

export const recordPayment: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.recordPayment(id, req.body as RecordPaymentBody), 201);
};
