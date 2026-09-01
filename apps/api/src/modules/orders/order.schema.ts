/**
 * Order DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { ORDER_CATEGORIES, ORDER_PRIORITIES, ORDER_STATUSES } from "./order.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const placeOrderSchema = z
  .object({
    /** REQUIRED. An order belongs to a visit, never to a note (ADR-0013 §3). */
    encounterId: objectId,
    category: z.enum(ORDER_CATEGORIES),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    priority: z.enum(ORDER_PRIORITIES).default("routine"),
    notes: z.string().max(1000).optional(),
    departmentId: objectId.optional(),
    /**
     * Client-supplied idempotency key. Optional, but the UI should always send one:
     * a doctor double-clicking "Order CBC" must not draw two tubes of blood, and a
     * retry after a timeout must not either — the first request may well have
     * succeeded before the connection dropped, which is the case a disabled button
     * cannot save you from.
     */
    requestId: z.string().min(8).max(64).optional(),
    branchId: objectId.optional(),
  })
  .strict();

/** Note there is no `patientId` — it is taken from the ENCOUNTER. A caller who could
 * name the patient could attach a test to somebody else's chart. */

const resultValueSchema = z
  .object({
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    value: z.string().min(1).max(200),
    unit: z.string().max(32).optional(),
    referenceRange: z.string().max(64).optional(),
    flag: z.string().max(32).optional(),
  })
  .strict();

export const completeOrderSchema = z
  .object({
    summary: z.string().max(5000).optional(),
    values: z.array(resultValueSchema).max(200).optional(),
    /**
     * A value that can kill the patient today.
     *
     * Setting this raises the alert SYNCHRONOUSLY, before verification — the warning
     * does not wait for a pathologist to come back from lunch (order.service.ts).
     */
    critical: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.summary) || Boolean(v.values?.length), {
    message: "a completed order must carry a result: a summary, values, or both",
  });

export const listOrdersQuerySchema = z
  .object({
    category: z.enum(ORDER_CATEGORIES).optional(),
    status: z.enum(ORDER_STATUSES).optional(),
    priority: z.enum(ORDER_PRIORITIES).optional(),
    encounterId: objectId.optional(),
    patientId: objectId.optional(),
    /** The department worklist: everything not yet released or cancelled. */
    outstanding: z.coerce.boolean().optional(),
    /**
     * WHICH QUESTION IS BEING ASKED OF THIS LIST.
     *
     * `queue` (the default, and what every existing caller gets) is a WORKLIST: sickest first,
     * then longest-waiting. That is how a bench is worked and it must not change.
     *
     * `recent` is a CHART: what came back most recently. The patient page was asking the worklist
     * question and rendering the answer as a history — which is wrong on its own, and becomes a
     * defect at the `limit` ceiling of 100: a long-stay patient's newest results, the ones a
     * doctor is actually waiting for, were the first to be cut off and were never shown at all.
     */
    sort: z.enum(["queue", "recent"]).default("queue"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

/** Cancellation REQUIRES a reason — "cancelled" with no why is useless downstream. */
export const cancelOrderSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

export type PlaceOrderBody = z.infer<typeof placeOrderSchema>;
export type CompleteOrderBody = z.infer<typeof completeOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
