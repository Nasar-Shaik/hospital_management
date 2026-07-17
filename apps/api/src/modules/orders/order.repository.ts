/**
 * Order repository — the ONLY code that queries `orders` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getOrderModel,
  isOutstanding,
  rankOf,
  AWAITED_CATEGORIES,
  ORDER_STATUSES,
  type OrderCategory,
  type OrderDoc,
  type OrderHistoryEntry,
  type OrderPriority,
  type OrderResultValue,
  type OrderStatus,
} from "./order.model.js";

export { isDuplicateKey };

/** The states in which somebody still owes somebody else something. */
const OUTSTANDING: OrderStatus[] = ORDER_STATUSES.filter(isOutstanding);

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Order {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: OrderCategory;
  code: string;
  name: string;
  priority: OrderPriority;
  status: OrderStatus;
  notes?: string;
  orderedBy: string;
  orderedAt: Date;
  departmentId?: string;
  performedBy?: string;
  completedAt?: Date;
  verifiedBy?: string;
  verifiedAt?: Date;
  releasedAt?: Date;
  result?: { summary?: string; values?: OrderResultValue[]; critical?: boolean };
  cancelReason?: string;
  requestId?: string;
  branchId?: string;
  history: OrderHistoryEntry[];
  createdAt: Date;
}

function toOrder(doc: OrderDoc): Order {
  return {
    id: doc._id.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    category: doc.category,
    code: doc.code,
    name: doc.name,
    priority: doc.priority,
    status: doc.status,
    orderedBy: doc.orderedBy,
    orderedAt: doc.orderedAt,
    history: doc.history ?? [],
    createdAt: doc.createdAt,
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.departmentId ? { departmentId: doc.departmentId } : {}),
    ...(doc.performedBy ? { performedBy: doc.performedBy } : {}),
    ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
    ...(doc.verifiedBy ? { verifiedBy: doc.verifiedBy } : {}),
    ...(doc.verifiedAt ? { verifiedAt: doc.verifiedAt } : {}),
    ...(doc.releasedAt ? { releasedAt: doc.releasedAt } : {}),
    ...(doc.result ? { result: doc.result } : {}),
    ...(doc.cancelReason ? { cancelReason: doc.cancelReason } : {}),
    ...(doc.requestId ? { requestId: doc.requestId } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateOrderInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  category: OrderCategory;
  code: string;
  name: string;
  priority: OrderPriority;
  notes?: string;
  departmentId?: string;
  requestId?: string;
  branchId?: string;
  /** Service-only; defaults to the caller. See `PlaceOrderInput.orderedBy` for why. */
  orderedBy?: string;
}

/**
 * Places the order.
 *
 * Throws a duplicate-key error when a `requestId` has already been used — BY DESIGN.
 * The service catches it and hands back the order that already exists, because a
 * doctor whose "Order CBC" click timed out and was retried wants one tube of blood
 * drawn, not two. The arbiter is the unique index (migration 0013), not a
 * read-then-write, because the retry and the original can be in flight at once.
 */
export async function create(input: CreateOrderInput, session: ClientSession): Promise<Order> {
  const ctx = getContext();

  const [doc] = await getOrderModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        category: input.category,
        code: input.code,
        name: input.name,
        priority: input.priority,
        // Derived here, so no caller can ever store a rank that disagrees with the
        // priority it claims to represent.
        priorityRank: rankOf(input.priority),
        status: "placed",
        /**
         * The doctor who asked. This is who the result comes back to, so it is taken
         * from the authenticated caller and never from the request body — `orderedBy`
         * is absent from `placeOrderSchema`, and `validate()` strips what a schema does
         * not declare, so an HTTP client cannot reach this line.
         *
         * A CONSUMER may pass it, because a consumer has no authenticated caller: the
         * pharmacy order raised from `prescription.signed` belongs to the doctor who
         * signed it, not to the relay that delivered the event.
         */
        orderedBy: input.orderedBy ?? ctx.userId ?? "system",
        orderedAt: new Date(),
        history: [],
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    ],
    { session },
  );

  if (!doc) throw new Error("order insert returned nothing");
  return toOrder(doc);
}

export async function findById(id: string): Promise<Order | undefined> {
  const doc = await getOrderModel(getTenantDb())
    .findOne({ _id: id, ...scopeFilter("orderedBy") })
    .lean<OrderDoc>();
  return doc ? toOrder(doc) : undefined;
}

export async function findByRequestId(requestId: string): Promise<Order | undefined> {
  const doc = await getOrderModel(getTenantDb()).findOne({ requestId }).lean<OrderDoc>();
  return doc ? toOrder(doc) : undefined;
}

/* ── Reporting: the diagnostics register (period on `orderedAt`, half-open) ──── */

/** The order categories that ARE diagnostic tests — what "how many tests" means. */
const DIAGNOSTIC_CATEGORIES = ["lab", "radiology"] as const;

export interface DiagnosticsReport {
  /** Diagnostic orders raised in the period (cancelled excluded). */
  total: number;
  /** How many of those were actually performed (carry a performer). */
  performed: number;
  byCategory: { category: string; ordered: number; performed: number }[];
  /** Who performed the tests, busiest first. Only orders that were performed appear here. */
  byPerformer: { performedBy: string; performed: number }[];
}

/**
 * The diagnostics register: how many tests were ordered and performed in a period, by category
 * and by who ran them.
 *
 * The period is on `orderedAt` (when the test was requested — there is no separate performed
 * clock), half-open `[from, to)`, cancelled orders excluded. "Performed" means the order carries
 * a `performedBy`: the person the register credits with running the test, which is exactly the
 * "by who" an auditor asks for. Tenant-scoped by the aggregate hook.
 */
export async function diagnosticsReport(from: Date, to: Date): Promise<DiagnosticsReport> {
  const model = getOrderModel(getTenantDb());
  const match = {
    orderedAt: { $gte: from, $lt: to },
    category: { $in: DIAGNOSTIC_CATEGORIES },
    status: { $ne: "cancelled" },
  };
  const facet = await model.aggregate<{
    total: { count: number }[];
    performed: { count: number }[];
    byCategory: { _id: string; ordered: number; performed: number }[];
    byPerformer: { _id: string; performed: number }[];
  }>([
    { $match: match },
    {
      $facet: {
        total: [{ $count: "count" }],
        performed: [{ $match: { performedBy: { $exists: true, $ne: null } } }, { $count: "count" }],
        byCategory: [
          {
            $group: {
              _id: "$category",
              ordered: { $sum: 1 },
              performed: {
                $sum: { $cond: [{ $ifNull: ["$performedBy", false] }, 1, 0] },
              },
            },
          },
          { $sort: { ordered: -1 } },
        ],
        byPerformer: [
          { $match: { performedBy: { $exists: true, $ne: null } } },
          { $group: { _id: "$performedBy", performed: { $sum: 1 } } },
          { $sort: { performed: -1 } },
        ],
      },
    },
  ]);
  const f = facet[0];
  return {
    total: f?.total[0]?.count ?? 0,
    performed: f?.performed[0]?.count ?? 0,
    byCategory: (f?.byCategory ?? []).map((r) => ({
      category: r._id,
      ordered: r.ordered,
      performed: r.performed,
    })),
    byPerformer: (f?.byPerformer ?? []).map((r) => ({
      performedBy: r._id,
      performed: r.performed,
    })),
  };
}

/**
 * Moves the order, and records WHO moved it.
 *
 * The history is not decoration. "Who verified this result" is the first question
 * asked when a result turns out to be wrong, and the answer has to survive the person
 * leaving the hospital.
 */
export async function setStatus(
  id: string,
  to: OrderStatus,
  entry: OrderHistoryEntry,
  session: ClientSession,
  alsoSet: Record<string, unknown> = {},
): Promise<Order | undefined> {
  const doc = await getOrderModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      { $set: { status: to, ...alsoSet }, $push: { history: entry } },
      { new: true, session },
    )
    .lean<OrderDoc>();

  return doc ? toOrder(doc) : undefined;
}

/**
 * Is the doctor still waiting on a result for this encounter?
 *
 * This is the question that decides whether a patient sitting in `awaiting_results`
 * can be called back in to the doctor. Getting it wrong in one direction strands the
 * patient in the waiting room; getting it wrong in the other calls them in before
 * their results exist.
 *
 * ── SCOPED TO THE CATEGORIES A DOCTOR ACTUALLY WAITS ON ─────────────────────
 * Not every outstanding order is something the consultation is blocked on. A prescription
 * is collected on the way OUT — counting it here would mean the CBC coming back never
 * brings the patient in, because the pharmacy order stays open until they wander over to
 * the counter. See `AWAITED_CATEGORIES` for why each category is in or out.
 */
export async function isWaitingOnResults(encounterId: string): Promise<boolean> {
  const count = await getOrderModel(getTenantDb()).countDocuments({
    encounterId: new Types.ObjectId(encounterId),
    category: { $in: AWAITED_CATEGORIES },
    status: { $in: OUTSTANDING },
  });

  return count > 0;
}

export interface ListOrdersFilter {
  category?: OrderCategory;
  status?: OrderStatus;
  encounterId?: string;
  patientId?: string;
  priority?: OrderPriority;
  /** The department worklist: everything not yet released or cancelled. */
  outstandingOnly?: boolean;
  limit: number;
  skip: number;
}

/**
 * THE DEPARTMENT'S WORKLIST IS THIS QUERY.
 *
 * "Doctor orders appear automatically in the destination department" is not a feature
 * somebody has to build a hand-off for — `?category=lab&outstanding=true` IS the lab's
 * list, and an order joins it the instant it commits.
 *
 * Sorted by priority and then by age: a `stat` placed a minute ago outranks a
 * `routine` placed an hour ago, and among equals the oldest is done first. A worklist
 * sorted purely by time is a worklist where the emergency waits its turn.
 */
export async function list(filter: ListOrdersFilter): Promise<{ items: Order[]; total: number }> {
  const model = getOrderModel(getTenantDb());

  const query: Record<string, unknown> = {
    ...scopeFilter("orderedBy"),
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.priority ? { priority: filter.priority } : {}),
    ...(filter.encounterId ? { encounterId: new Types.ObjectId(filter.encounterId) } : {}),
    ...(filter.patientId ? { patientId: new Types.ObjectId(filter.patientId) } : {}),
    ...(filter.outstandingOnly ? { status: { $in: OUTSTANDING } } : {}),
  };

  const [docs, total] = await Promise.all([
    model
      // Sickest first, then oldest. Never the other way round.
      .find(query)
      .sort({ priorityRank: 1, orderedAt: 1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<OrderDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toOrder), total };
}
