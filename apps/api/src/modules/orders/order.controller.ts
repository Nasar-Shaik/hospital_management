/**
 * Order controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import * as orders from "./order.service.js";
import type { CompleteOrderBody, ListOrdersQuery, PlaceOrderBody } from "./order.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

/**
 * Places an order.
 *
 * Returns **200 with `duplicate: true`** when this `requestId` had already placed it —
 * not a 409. A retry that gets an error will be retried again; a retry that gets the
 * order it asked for is finished. 201 only when something new was actually created.
 */
export const placeOrder: RequestHandler = async (req, res) => {
  const result = await orders.placeOrder(req.body as PlaceOrderBody);
  ok(res, result, result.duplicate ? 200 : 201);
};

/**
 * THE DEPARTMENT'S WORKLIST.
 *
 * `?category=lab&outstanding=true` is the lab's list, and an order joins it the
 * instant it commits — which is the whole of "orders appear automatically in the
 * destination department". There is no hand-off, so there is no hand-off to forget.
 */
export const listOrders: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListOrdersQuery;

  const { items, total } = await orders.listOrders({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.category ? { category: query.category } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.encounterId ? { encounterId: query.encounterId } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.outstanding ? { outstandingOnly: true } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const order = await orders.getOrder(id);
  if (!order) throw new AppError("HMS-GEN-404", 404, "Order not found", { id });
  ok(res, order);
};

export const acceptOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await orders.acceptOrder(id));
};

export const startOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await orders.startOrder(id));
};

export const completeOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await orders.completeOrder(id, req.body as CompleteOrderBody));
};

export const verifyOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await orders.verifyOrder(id));
};

export const releaseOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await orders.releaseOrder(id));
};

export const cancelOrder: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { reason } = req.body as { reason: string };
  ok(res, await orders.cancelOrder(id, reason));
};
