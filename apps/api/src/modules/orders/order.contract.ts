/**
 * Order response contracts — investigations and their results.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { ORDER_CATEGORIES, ORDER_PRIORITIES, ORDER_STATUSES } from "./order.model.js";
import type { Order } from "./order.repository.js";
import type { PlaceOrderResult } from "./order.service.js";

const orderStatus = z.enum(ORDER_STATUSES);

export const orderResultValue = contract(
  "OrderResultValue",
  z.object({
    code: z.string(),
    label: z.string(),
    value: z.string(),
    unit: z.string().optional(),
    referenceRange: z.string().optional(),
    /** `low | high | critical_low | critical_high | normal` — the analyser's own flag. */
    flag: z.string().optional(),
  }),
);

export const orderHistoryEntry = contract(
  "OrderHistoryEntry",
  z.object({
    from: orderStatus,
    to: orderStatus,
    at: z.string(),
    by: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export const order = contract(
  "Order",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    category: z.enum(ORDER_CATEGORIES),
    code: z.string(),
    name: z.string(),
    priority: z.enum(ORDER_PRIORITIES),
    status: orderStatus,
    notes: z.string().optional(),
    orderedBy: z.string(),
    orderedAt: z.string(),
    departmentId: z.string().optional(),
    performedBy: z.string().optional(),
    completedAt: z.string().optional(),
    verifiedBy: z.string().optional(),
    verifiedAt: z.string().optional(),
    releasedAt: z.string().optional(),
    result: z
      .object({
        summary: z.string().optional(),
        values: z.array(orderResultValue).optional(),
        /** A critical result — it raises an alert the moment it is released. */
        critical: z.boolean().optional(),
      })
      .optional(),
    cancelReason: z.string().optional(),
    requestId: z.string().optional(),
    branchId: z.string().optional(),
    history: z.array(orderHistoryEntry),
    createdAt: z.string(),
  }),
);
export type OrderProof = Proves<Matches<typeof order, Order>>;

/** 201 for a new order, 200 when this `requestId` had already placed it — a retry, not a second. */
export const placeOrderResult = contract(
  "PlaceOrderResult",
  z.object({ order, duplicate: z.boolean() }),
);
export type PlaceOrderResultProof = Proves<Matches<typeof placeOrderResult, PlaceOrderResult>>;
