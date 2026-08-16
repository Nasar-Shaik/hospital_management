/**
 * Order response contracts — investigations and their results.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { ORDER_CATEGORIES, ORDER_PRIORITIES, ORDER_STATUSES } from "./order.model.js";
import type { Order } from "./order.repository.js";
import type { OrderRow, PlaceOrderResult } from "./order.service.js";

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

/**
 * A worklist row — the order WITH its patient's identity.
 *
 * Only the LIST carries this. A single order is fetched by someone who already knows whose it is;
 * a queue is read by a technician deciding whose sample to run next, and a row that cannot name
 * its patient is the ambiguity the whole two-person rule exists to close. Resolved server-side
 * (`namesByIds`) because the alternative — a client joining against a page of patients — silently
 * drops the ones that page did not reach. See `listOrders` for what that cost.
 */
export const orderRow = contract(
  "OrderRow",
  order.extend({
    /** `Unknown patient` when the record cannot be read — never silently blank. */
    patientName: z.string(),
    /** Empty only when the patient record itself carries none. */
    uhid: z.string(),
  }),
);
export type OrderRowProof = Proves<Matches<typeof orderRow, OrderRow>>;

/** 201 for a new order, 200 when this `requestId` had already placed it — a retry, not a second. */
export const placeOrderResult = contract(
  "PlaceOrderResult",
  z.object({ order, duplicate: z.boolean() }),
);
export type PlaceOrderResultProof = Proves<Matches<typeof placeOrderResult, PlaceOrderResult>>;
