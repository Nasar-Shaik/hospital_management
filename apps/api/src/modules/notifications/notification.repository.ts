/**
 * Notification repository — the ONLY code that queries `notifications` and
 * `notificationTemplates` (Constitution §6).
 */
import { getTenantDb, getContext } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getNotificationModel,
  getTemplateModel,
  type NotificationChannel,
  type NotificationDoc,
  type NotificationStatus,
  type NotificationTemplateDoc,
} from "./notification.model.js";

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Notification {
  id: string;
  templateKey: string;
  channel: NotificationChannel;
  /** Absent when the recipient had no address on this channel — see `unreachable`. */
  to?: string;
  recipientName?: string;
  recipientType?: string;
  recipientId?: string;
  subject?: string;
  body: string;
  dedupeKey: string;
  status: NotificationStatus;
  attempts: number;
  sentAt?: Date;
  error?: string;
  eventId?: string;
  createdAt: Date;
}

export interface NotificationTemplate {
  id: string;
  key: string;
  channel: NotificationChannel;
  description?: string;
  subject?: string;
  body: string;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: Date;
}

function toNotification(doc: NotificationDoc): Notification {
  return {
    id: doc._id.toString(),
    templateKey: doc.templateKey,
    channel: doc.channel,
    body: doc.body,
    dedupeKey: doc.dedupeKey,
    status: doc.status,
    attempts: doc.attempts,
    createdAt: doc.createdAt,
    ...(doc.to ? { to: doc.to } : {}),
    ...(doc.recipientName ? { recipientName: doc.recipientName } : {}),
    ...(doc.recipientType ? { recipientType: doc.recipientType } : {}),
    ...(doc.recipientId ? { recipientId: doc.recipientId } : {}),
    ...(doc.subject ? { subject: doc.subject } : {}),
    ...(doc.sentAt ? { sentAt: doc.sentAt } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    ...(doc.eventId ? { eventId: doc.eventId } : {}),
  };
}

function toTemplate(doc: NotificationTemplateDoc): NotificationTemplate {
  return {
    id: doc._id.toString(),
    key: doc.key,
    channel: doc.channel,
    body: doc.body,
    enabled: doc.enabled,
    isDefault: doc.isDefault,
    updatedAt: doc.updatedAt,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.subject ? { subject: doc.subject } : {}),
  };
}

export interface ClaimInput {
  dedupeKey: string;
  templateKey: string;
  channel: NotificationChannel;
  /** Omitted when the recipient has no address on this channel. */
  to?: string;
  body: string;
  subject?: string;
  recipientName?: string;
  recipientType?: string;
  recipientId?: string;
  branchId?: string;
  eventId?: string;
}

export type ClaimResult =
  /** We own the delivery. Send it. */
  | { kind: "owned"; notification: Notification }
  /** It reached a terminal state already. Send nothing. */
  | { kind: "settled"; status: NotificationStatus }
  /** Another sender holds a live lease on it. Back off and let them finish. */
  | { kind: "inFlight" };

/**
 * How long a sender's lease is honoured before we assume it died mid-send.
 *
 * The same 60s the outbox relay uses to reclaim a crashed relay's rows
 * (outboxRelay.STALE_CLAIM_MS). Long enough that a slow SMTP handshake is not
 * mistaken for a corpse; short enough that a genuinely dead sender's message goes
 * out on a retry rather than never.
 */
const STALE_CLAIM_MS = 60_000;

/**
 * ── THE IDEMPOTENCY DOOR ─────────────────────────────────────────────────────
 *
 * Delivery is at-least-once (ADR-0007). This consumer WILL be handed the same
 * `appointment.booked` twice — by a relay that crashed after enqueueing but before
 * marking sent, by a BullMQ retry, by an operator replaying a DLQ. Without this
 * function the patient gets two confirmation emails, and the hospital's trust in
 * the system goes with them.
 *
 * The check is the INDEX, not an `if`. `{tenantId, dedupeKey}` is unique
 * (migration 0011): two handlers racing on one event do not both "see nothing and
 * insert" — one inserts and the other is refused by the database. That is the only
 * arbitration that works under concurrency, and it is the same philosophy as the
 * appointment slot: correctness by database, not by check.
 *
 * ── A BUG THIS FUNCTION USED TO HAVE, BECAUSE IT IS THE OBVIOUS ONE TO WRITE ──
 * The first version said: if the row already exists and is not yet `sent`, send it
 * — reasoning that a `pending` row must have been left by a sender that DIED, and
 * that skipping would lose the message forever.
 *
 * That reasoning is right about the dead sender and wrong about everything else.
 * `pending` also describes a sender that is alive and *currently inside the SMTP
 * call*. The recovery path for a corpse fired for a healthy handler, and the patient
 * got two emails. The suite caught it: two racing deliveries, two messages in the
 * inbox, one row in the ledger.
 *
 * The fix is a LEASE. A sender stamps `claimedAt` when it takes the row, so the two
 * cases stop looking alike:
 *
 *   sent / unreachable / suppressed  → terminal. Nothing to do, ever.
 *   pending, lease is FRESH          → someone is sending it right now. Refuse.
 *   pending, lease is STALE (>60s)   → that sender is not coming back. Take over.
 *   failed                           → SMTP refused last time. Retry is the point.
 *
 * A refused caller throws (see notification.service), so its job retries rather than
 * reporting a success it did not achieve — and by then the row is either `sent` (it
 * skips, cleanly) or stale (it takes over). The message cannot be lost, and it
 * cannot be doubled.
 */
export async function claim(input: ClaimInput): Promise<ClaimResult> {
  const ctx = getContext();
  const model = getNotificationModel(getTenantDb());
  const now = new Date();

  // 1. Try to take it by inserting. The unique index is the arbiter.
  try {
    const [doc] = await model.create([
      {
        tenantId: ctx.tenantId,
        dedupeKey: input.dedupeKey,
        templateKey: input.templateKey,
        channel: input.channel,
        body: input.body,
        ...(input.to ? { to: input.to } : {}),
        status: "pending" as NotificationStatus,
        attempts: 1,
        claimedAt: now,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.recipientName ? { recipientName: input.recipientName } : {}),
        ...(input.recipientType ? { recipientType: input.recipientType } : {}),
        ...(input.recipientId ? { recipientId: input.recipientId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      },
    ]);

    if (doc) return { kind: "owned", notification: toNotification(doc) };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Someone else got there first. Fall through and find out what they did with it.
  }

  const existing = await model
    .findOne({ tenantId: ctx.tenantId, dedupeKey: input.dedupeKey })
    .lean<NotificationDoc>();

  // The row was there a microsecond ago (that is why the insert failed) and is gone
  // now. Nothing deletes notifications, so this cannot happen — and if it somehow
  // does, refusing is the safe answer: the retry will re-derive the truth.
  if (!existing) return { kind: "inFlight" };

  if (existing.status !== "pending" && existing.status !== "failed") {
    return { kind: "settled", status: existing.status };
  }

  // 2. Take over ONLY if the previous sender is failed or demonstrably dead. The
  //    condition is part of the update, not a read before it — a check-then-write
  //    would let two reclaimers both decide the lease was stale.
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  const taken = await model.findOneAndUpdate(
    {
      _id: existing._id,
      $or: [{ status: "failed" }, { status: "pending", claimedAt: { $lt: staleBefore } }],
    },
    { $set: { claimedAt: now, status: "pending" as NotificationStatus }, $inc: { attempts: 1 } },
    { new: true },
  );

  return taken ? { kind: "owned", notification: toNotification(taken) } : { kind: "inFlight" };
}

/** Releases the lease along with the outcome — the row is terminal now. */
export async function markSent(id: string): Promise<void> {
  await getNotificationModel(getTenantDb()).updateOne(
    { _id: id },
    { $set: { status: "sent", sentAt: new Date() }, $unset: { error: 1, claimedAt: 1 } },
  );
}

/** `failed` (ours), `unreachable` (no address) or `suppressed` (switch off). */
export async function markOutcome(
  id: string,
  status: Exclude<NotificationStatus, "pending" | "sent">,
  error: string,
): Promise<void> {
  await getNotificationModel(getTenantDb()).updateOne(
    { _id: id },
    // The lease goes too. `failed` must be immediately retryable — waiting 60s for
    // a lease to expire before retrying a message we KNOW nobody is sending would
    // be a delay with no purpose.
    { $set: { status, error: error.slice(0, 500) }, $unset: { claimedAt: 1 } },
  );
}

export interface ListFilter {
  status?: NotificationStatus;
  recipientId?: string;
  templateKey?: string;
  limit: number;
  skip: number;
}

export async function list(filter: ListFilter): Promise<{ items: Notification[]; total: number }> {
  const model = getNotificationModel(getTenantDb());
  const query = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.recipientId ? { recipientId: filter.recipientId } : {}),
    ...(filter.templateKey ? { templateKey: filter.templateKey } : {}),
  };

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ createdAt: -1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<NotificationDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toNotification), total };
}

/* ── Templates ─────────────────────────────────────────────────────────────── */

export async function findTemplate(key: string): Promise<NotificationTemplate | undefined> {
  const doc = await getTemplateModel(getTenantDb())
    .findOne({ key })
    .lean<NotificationTemplateDoc>();
  return doc ? toTemplate(doc) : undefined;
}

export async function listTemplates(): Promise<NotificationTemplate[]> {
  const docs = await getTemplateModel(getTenantDb())
    .find({})
    .sort({ key: 1 })
    .lean<NotificationTemplateDoc[]>();
  return docs.map(toTemplate);
}

export interface UpdateTemplateInput {
  subject?: string;
  body?: string;
  enabled?: boolean;
}

/**
 * A hospital edits the wording. `isDefault` flips to false the moment they do,
 * which is what keeps a later seed run from silently reverting their words back to
 * ours (see seedNotificationTemplates).
 */
export async function updateTemplate(
  key: string,
  input: UpdateTemplateInput,
): Promise<NotificationTemplate | undefined> {
  const doc = await getTemplateModel(getTenantDb()).findOneAndUpdate(
    { key },
    {
      $set: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        isDefault: false,
      },
    },
    { new: true },
  );

  return doc ? toTemplate(doc) : undefined;
}
