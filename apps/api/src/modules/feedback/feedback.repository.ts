/**
 * Feedback ticket repository — the ONLY code that queries `feedbackTickets` (Constitution §6).
 *
 * Branch-aware like every operational collection: reads pass through `scopeFilter()` and writes
 * stamp the active `branchId`.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getFeedbackTicketModel,
  type FeedbackTicketDoc,
  type FeedbackKind,
  type FeedbackCategory,
  type FeedbackChannel,
  type ComplaintSeverity,
  type FeedbackStatus,
  type FeedbackStatusChange,
} from "./feedback.model.js";

export interface FeedbackTicket {
  id: string;
  kind: FeedbackKind;
  category: FeedbackCategory;
  channel: FeedbackChannel;
  subject: string;
  description: string;
  patientId?: string;
  reporterName?: string;
  reporterPhone?: string;
  rating?: number;
  severity?: ComplaintSeverity;
  status: FeedbackStatus;
  assignedTo?: string;
  resolutionNote?: string;
  statusHistory: FeedbackStatusChange[];
  branchId?: string;
  createdAt: string;
  updatedAt: string;
}

function toTicket(doc: FeedbackTicketDoc): FeedbackTicket {
  return {
    id: doc._id.toString(),
    kind: doc.kind,
    category: doc.category,
    channel: doc.channel,
    subject: doc.subject,
    description: doc.description,
    ...(doc.patientId ? { patientId: doc.patientId } : {}),
    ...(doc.reporterName ? { reporterName: doc.reporterName } : {}),
    ...(doc.reporterPhone ? { reporterPhone: doc.reporterPhone } : {}),
    ...(doc.rating != null ? { rating: doc.rating } : {}),
    ...(doc.severity ? { severity: doc.severity } : {}),
    status: doc.status,
    ...(doc.assignedTo ? { assignedTo: doc.assignedTo } : {}),
    ...(doc.resolutionNote ? { resolutionNote: doc.resolutionNote } : {}),
    statusHistory: doc.statusHistory ?? [],
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export interface CreateTicketInput {
  kind: FeedbackKind;
  category: FeedbackCategory;
  channel: FeedbackChannel;
  subject: string;
  description: string;
  patientId?: string;
  reporterName?: string;
  reporterPhone?: string;
  rating?: number;
  severity?: ComplaintSeverity;
}

export async function createTicket(input: CreateTicketInput): Promise<FeedbackTicket> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getFeedbackTicketModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    kind: input.kind,
    category: input.category,
    channel: input.channel,
    subject: input.subject,
    description: input.description,
    ...(input.patientId ? { patientId: input.patientId } : {}),
    ...(input.reporterName ? { reporterName: input.reporterName } : {}),
    ...(input.reporterPhone ? { reporterPhone: input.reporterPhone } : {}),
    ...(input.rating != null ? { rating: input.rating } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    status: "open",
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toTicket(doc.toObject() as FeedbackTicketDoc);
}

export interface ListTicketsFilter {
  kind?: FeedbackKind;
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  assignedTo?: string;
}

/** The register, newest first — the desk's working list. */
export async function listTickets(filter: ListTicketsFilter): Promise<FeedbackTicket[]> {
  const q: Record<string, unknown> = { ...scopeFilter() };
  if (filter.kind) q.kind = filter.kind;
  if (filter.status) q.status = filter.status;
  if (filter.category) q.category = filter.category;
  if (filter.assignedTo) q.assignedTo = filter.assignedTo;
  const docs = await getFeedbackTicketModel(getTenantDb())
    .find(q)
    .sort({ createdAt: -1 })
    .lean<FeedbackTicketDoc[]>();
  return docs.map(toTicket);
}

export async function findById(id: string): Promise<FeedbackTicket | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getFeedbackTicketModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<FeedbackTicketDoc>();
  return doc ? toTicket(doc) : undefined;
}

/** The raw doc — the transition path reads this to check the state machine. */
export async function findDocById(id: string): Promise<FeedbackTicketDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getFeedbackTicketModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<FeedbackTicketDoc>();
  return doc ?? undefined;
}

export async function assign(
  id: string,
  assignedTo: string | null,
): Promise<FeedbackTicket | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const update = assignedTo === null ? { $unset: { assignedTo: "" } } : { $set: { assignedTo } };
  const doc = await getFeedbackTicketModel(getTenantDb())
    .findOneAndUpdate({ _id: new Types.ObjectId(id), ...scopeFilter() }, update, { new: true })
    .lean<FeedbackTicketDoc>();
  return doc ? toTicket(doc) : undefined;
}

/**
 * Applies a state transition: writes the new status, appends the history line, and — when the ticket
 * reaches `resolved` — records how (`resolutionNote`). Mirrors the ambulance/appointment machines.
 */
export async function setStatus(
  id: string,
  to: FeedbackStatus,
  change: FeedbackStatusChange,
): Promise<FeedbackTicket | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const set: Record<string, unknown> = { status: to };
  const unset: Record<string, unknown> = {};
  if (to === "resolved" && change.note) set.resolutionNote = change.note;
  // Re-opening drops the stale resolution note so the ticket does not claim to be fixed.
  if (to === "in_progress") unset.resolutionNote = "";

  const doc = await getFeedbackTicketModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $push: { statusHistory: change },
      },
      { new: true },
    )
    .lean<FeedbackTicketDoc>();
  return doc ? toTicket(doc) : undefined;
}
