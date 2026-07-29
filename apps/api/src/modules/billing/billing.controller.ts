/**
 * Billing controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import { getEncounter } from "../encounters/index.js";
import * as billing from "./billing.service.js";
import type {
  ListInvoicesQuery,
  PostChargeBody,
  RecordPaymentBody,
  ApplyDiscountBody,
  RecordRefundBody,
  PayerSplitBody,
  CreateServiceBody,
  UpdateServiceBody,
} from "./billing.schema.js";
import type { ChargeCategory } from "./billing.model.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/**
 * PAID / UNPAID per order — for the lab & imaging worklist. Takes `?orderIds=a,b,c`. A status flag
 * only (no amounts), so it is reachable with `order:read`, which a technician holds.
 */
export const orderPayments: RequestHandler = async (req, res) => {
  const raw = typeof req.query.orderIds === "string" ? req.query.orderIds : "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  ok(res, await billing.orderPaymentStatus(ids));
};

/**
 * PAID / UNPAID per ENCOUNTER's consultation (OP fee) — reception's "pay before you queue" gate.
 * Takes `?encounterIds=a,b,c`. A status flag only (no amounts), so a receptionist holding
 * `encounter:read` can see whether to route the patient to the cash counter.
 */
export const consultationPayments: RequestHandler = async (req, res) => {
  const raw = typeof req.query.encounterIds === "string" ? req.query.encounterIds : "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  ok(res, await billing.consultationPaymentStatus(ids));
};

/**
 * Per order: is the patient admitted, what is their advance balance, and this test's amount — the
 * lab worklist's "proceed from advance" panel. Takes `?orderIds=a,b,c`. Reachable with `order:read`.
 */
export const orderSettlement: RequestHandler = async (req, res) => {
  const raw = typeof req.query.orderIds === "string" ? req.query.orderIds : "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  ok(res, await billing.orderSettlementInfo(ids));
};

/** Settles one admitted-patient test from their advance — the lab tech's "proceed" action. */
export const settleOrderFromAdvance: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.settleOrderFromAdvance(id));
};

/** The tariff — what this hospital charges for things. Prices included. */
export const listServices: RequestHandler = async (req, res) => {
  const { category } = req.query as { category?: never };
  ok(res, await billing.listServices(category));
};

/* ── Tariff management (needs tariff:manage; prices are visible and editable) ── */

/** The full price list, retired entries included — what the tariff manager edits. */
export const listAllServices: RequestHandler = async (req, res) => {
  const { category } = req.query as { category?: ChargeCategory };
  ok(res, await billing.listAllServices(category));
};

export const createService: RequestHandler = async (req, res) => {
  const body = req.body as CreateServiceBody;
  ok(res, await billing.createServiceItem(body), 201);
};

export const updateService: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const body = req.body as UpdateServiceBody;
  ok(res, await billing.updateServiceItem(id, body));
};

/**
 * The CATALOGUE — what this hospital can do. Deliberately price-free.
 *
 * ── THE RATE CARD IS NOT THE BILL, AND THIS IS THE DIFFERENCE ───────────────
 * A doctor needs to know a chest X-ray can be ordered here. They do not need the
 * price on the screen while a patient is in front of them — `billing:read` is not in
 * the DOCTOR grant precisely so that what a patient can afford cannot shape what they
 * are offered.
 *
 * That is why this is a second route rather than a flag on the first: the order pad
 * asks "what can I order?", the counter asks "what does it cost?", and they are
 * different questions from different people with different permissions. One endpoint
 * serving both would have to hand the price to whoever asked, or lie about it.
 */
export const listCatalogue: RequestHandler = async (req, res) => {
  const { category } = req.query as { category?: never };
  const services = await billing.listServices(category);

  // Price stripped at the edge, not filtered in the UI. A price that reaches the
  // browser has been disclosed, whatever the screen chooses to render.
  ok(
    res,
    services.map((s) => ({ id: s.id, code: s.code, name: s.name, category: s.category })),
  );
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

/**
 * The per-batch billing view — pending charges + every bill on the visit. The desk's collection
 * screen reads this, and the OPD slip and ward totals are computed from it.
 */
/** Every charge posted on a visit, WITH its date — the day-wise money on the IP treatment sheet. */
export const encounterCharges: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.getCharges(id));
};

export const getEncounterBilling: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };

  const encounter = await getEncounter(id);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Encounter not found", { id });

  ok(res, await billing.getEncounterBilling(id));
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

export const applyDiscount: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.applyDiscount(id, req.body as ApplyDiscountBody));
};

export const recordRefund: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.recordRefund(id, req.body as RecordRefundBody), 201);
};

export const setPayerSplit: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await billing.setPayerSplit(id, req.body as PayerSplitBody));
};
