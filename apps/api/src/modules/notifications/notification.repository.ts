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
  /** When the recipient opened it. Absent means unread. */
  readAt?: Date;
  /**
   * The site the message was raised at (ADR-0015). Stored since Phase 1 and, until now, never
   * returned — the write stamped it and the read dropped it, so the record knew which hospital it
   * belonged to and no caller could find out.
   */
  branchId?: string;
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
    ...(doc.readAt ? { readAt: doc.readAt } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
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

/* ── The recipient's own inbox ─────────────────────────────────────────────── */

/**
 * One message as its RECIPIENT sees it.
 *
 * ── WHY THIS IS MAPPED AND NOT JUST DECLARED ────────────────────────────────
 * `responds(inboxMessage.array())` VALIDATES the payload against the contract; it does not trim
 * it. The first version of this route returned the full `Notification` and passed its own
 * contract check, because every field the contract requires was present — the extra eleven
 * (`to`, `dedupeKey`, `attempts`, `status`, `recipientId`, …) simply rode along. A shape test
 * caught it. Narrowing has to happen HERE, where the document is read, or it does not happen.
 */
export interface InboxMessage {
  id: string;
  templateKey: string;
  subject?: string;
  body: string;
  branchId?: string;
  readAt?: Date;
  createdAt: Date;
}

function toInboxMessage(doc: NotificationDoc): InboxMessage {
  return {
    id: doc._id.toString(),
    templateKey: doc.templateKey,
    body: doc.body,
    createdAt: doc.createdAt,
    ...(doc.subject ? { subject: doc.subject } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    ...(doc.readAt ? { readAt: doc.readAt } : {}),
  };
}

export interface InboxFilter {
  recipientId: string;
  /** Only what has not been opened yet — what the badge counts. */
  unreadOnly?: boolean;
  limit: number;
  skip: number;
}

/**
 * ── WHY THE INBOX SHOWS ONLY `sent` ─────────────────────────────────────────
 * The ledger records every ATTEMPT, including the ones that went nowhere: a template somebody
 * disabled, an email with no SMTP host, a patient with no address. Those rows exist so an
 * administrator can answer "did they get it?" — and the honest answer for all of them is no.
 *
 * Listing them in a person's inbox would deliver, after the fact, a message the system already
 * recorded as undelivered. It would also make the read receipt meaningless: `readAt` on a
 * `suppressed` row says somebody read a message nobody sent.
 *
 * The suppressed ones are not lost — `GET /notifications?status=suppressed` is exactly the screen
 * for them, and it belongs to the administrator who can fix the cause, not to the clinician who
 * would only learn that something was withheld from them.
 *
 * ── THERE IS NO SEPARATE UNREAD COUNT, AND THAT IS THE POINT ────────────────
 * The bell needs a number and the dropdown needs the newest few. Both come from ONE call —
 * `?unread=true&limit=5` — because under that filter `meta.total` IS the unread count. An
 * `unread` field in the page meta would have had to live on `PageMeta`, which every paged
 * endpoint in the product shares, to serve one screen.
 *
 * ── AND WHY IT IS NOT BRANCH-SCOPED ─────────────────────────────────────────
 * Every other clinical read in this codebase narrows to the active branch, and this one
 * deliberately does not. A message is addressed to a PERSON, not to a site: a consultant who
 * switches the branch picker to look at another hospital site must not thereby lose the critical
 * potassium raised twenty minutes ago at the first one. Branch is recorded on the row and shown
 * on screen; it is not a filter. There is no leak in this — the only way a row names you is that
 * the domain addressed it to you.
 */
export async function listForRecipient(
  filter: InboxFilter,
): Promise<{ items: InboxMessage[]; total: number }> {
  const model = getNotificationModel(getTenantDb());

  const query = {
    recipientId: filter.recipientId,
    status: "sent" as NotificationStatus,
    ...(filter.unreadOnly ? { readAt: { $exists: false } } : {}),
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

  return { items: docs.map(toInboxMessage), total };
}

/**
 * Opening a message.
 *
 * ── THE FILTER IS THE AUTHORIZATION ─────────────────────────────────────────
 * `recipientId` is part of the WHERE clause, not checked afterwards. A caller holding somebody
 * else's notification id updates nothing and is told the message does not exist — which is the
 * truthful answer to them, and the one that does not confirm the row's existence to someone
 * fishing for ids.
 *
 * ── IDEMPOTENT, AND IT KEEPS THE FIRST TIME ─────────────────────────────────
 * Two tabs, or a retry, must not move `readAt` forward. The update only matches rows that have
 * no `readAt` yet, so the first read wins and the second finds nothing to change — at which point
 * the second query below distinguishes "already read" (return it as it stands) from "not yours"
 * (undefined). That distinction is the whole reason this is not one call: without it a re-read
 * and a forged id are indistinguishable, and one of them is a 404 and the other is not.
 */
export async function markRead(id: string): Promise<InboxMessage | undefined> {
  const ctx = getContext();
  const model = getNotificationModel(getTenantDb());
  const mine = { _id: id, recipientId: ctx.userId, status: "sent" as NotificationStatus };

  const opened = await model.findOneAndUpdate(
    { ...mine, readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (opened) return toInboxMessage(opened);

  const already = await model.findOne(mine).lean<NotificationDoc>();
  return already ? toInboxMessage(already) : undefined;
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
