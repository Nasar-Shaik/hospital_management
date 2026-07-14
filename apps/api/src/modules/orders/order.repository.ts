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
        // The doctor who asked. This is who the result comes back to, so it is taken
        // from the authenticated caller and never from the request body.
        orderedBy: ctx.userId ?? "system",
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
 * Is anything still owed on this encounter?
 *
 * This is the question that decides whether a patient sitting in `awaiting_results`
 * can be called back in to the doctor. Getting it wrong in one direction strands the
 * patient in the waiting room; getting it wrong in the other calls them in before
 * their results exist.
 */
export async function hasOutstandingOrders(encounterId: string): Promise<boolean> {
  const count = await getOrderModel(getTenantDb()).countDocuments({
    encounterId: new Types.ObjectId(encounterId),
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
