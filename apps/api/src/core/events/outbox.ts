/**
 * The transactional outbox (tenant DB `outboxEvents`, Doc 03 §5.2, ADR-0007).
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * A service that saves a patient and then pushes a job onto Redis is performing a
 * dual write to two systems that cannot commit together. Crash between them and
 * you get one of two silent corruptions:
 *
 *   save → CRASH → (no job)     the patient exists; nobody was ever notified
 *   job  → CRASH → (no save)    a welcome SMS about a patient who does not exist
 *
 * Neither is acceptable in a hospital, and no amount of try/catch fixes it: the
 * failure is between the two calls, not inside either.
 *
 * THE FIX
 * -------
 * The event is written to a collection in the SAME database as the mutation, in
 * the SAME transaction. One commit, one atom: either the patient and the intent
 * to notify both exist, or neither does. A separate relay (`outboxRelay.ts`) then
 * moves committed events onto the queue. The relay may crash, double-send, or run
 * twice — it can only ever cause an event to be delivered MORE than once, never
 * fewer. Which is why every consumer must be idempotent (ADR-0007), and why the
 * envelope carries a stable `eventId` for them to dedupe on.
 *
 * This is also the seam that makes a module extractable into a service later
 * (Doc 04 §2.4 rule 4) — consumers already listen to events rather than call code.
 *
 * WHY THE OUTBOX IS PER-TENANT
 * ----------------------------
 * Atomicity only exists inside one database, and the mutations that matter live
 * in the tenant's database. A master-DB change (a plan upgrade) therefore cannot
 * be atomic with an event in a tenant DB — such events are published *after* the
 * master write commits, and the gap is documented at each call site. They are
 * notification-only; the registry remains the source of truth.
 */
import { randomUUID } from "node:crypto";
import { Schema, type ClientSession, type Connection, type Model, type Types } from "mongoose";
import { getContext } from "../context/requestContext.js";
import type { EventName } from "./eventCatalog.js";

export const OUTBOX_STATUSES = ["pending", "processing", "sent", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxEventDoc {
  _id: Types.ObjectId;
  /** The consumer's dedupe key. Stable across every redelivery of this event. */
  eventId: string;
  name: string;
  version: number;
  tenantId: string;
  branchId?: string;
  occurredAt: Date;
  actorId?: string;
  traceId?: string;
  payload: Record<string, unknown>;

  status: OutboxStatus;
  attempts: number;
  /** Not before this instant — how retry backoff is expressed without a scheduler. */
  availableAt: Date;
  /** Set while a relay holds the row; a stale value is how a crashed relay is reclaimed. */
  claimedAt?: Date;
  sentAt?: Date;
  lastError?: string;
  createdAt: Date;
}

const outboxEventSchema = new Schema<OutboxEventDoc>(
  {
    eventId: { type: String, required: true },
    name: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    tenantId: { type: String, required: true },
    branchId: { type: String },
    occurredAt: { type: Date, required: true },
    actorId: { type: String },
    traceId: { type: String },
    payload: { type: Schema.Types.Mixed, required: true },

    status: { type: String, enum: OUTBOX_STATUSES, required: true, default: "pending" },
    attempts: { type: Number, required: true, default: 0 },
    availableAt: { type: Date, required: true },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    lastError: { type: String },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  // No tenantScopePlugin: the relay reads this collection from a background loop
  // that binds one tenant at a time explicitly, and an outbox row is never soft
  // deleted. Scoping is by `tenantId` on every query below.
  { timestamps: false, collection: "outboxEvents", autoIndex: false },
);

export function getOutboxModel(conn: Connection): Model<OutboxEventDoc> {
  return (
    (conn.models.OutboxEvent as Model<OutboxEventDoc>) ??
    conn.model<OutboxEventDoc>("OutboxEvent", outboxEventSchema)
  );
}

export interface PublishInput {
  name: EventName;
  payload: Record<string, unknown>;
  version?: number;
  branchId?: string;
}

/**
 * Records the intent to publish. Returns the `eventId` consumers will dedupe on.
 *
 * Pass the caller's `session` whenever the mutation this event describes runs in
 * a transaction — that is the entire reason this collection exists. Publishing
 * without a session is legal (an event about a change in *another* database, or a
 * single-document write that is already atomic on its own), but it is a decision,
 * not a default: without the session, a crash between the write and the publish
 * loses the event.
 *
 * Payloads carry IDs and minimal display fields — never full PHI documents
 * (EVENT_CATALOG global rules). The outbox is drained onto a Redis queue and may
 * be inspected by operators; it is not an appropriate home for a chart.
 */
export async function publish(input: PublishInput, session?: ClientSession): Promise<string> {
  const ctx = getContext();
  const eventId = randomUUID();
  const now = new Date();

  await getOutboxModel(ctx.connection).create(
    [
      {
        eventId,
        name: input.name,
        version: input.version ?? 1,
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        occurredAt: now,
        actorId: ctx.userId,
        traceId: ctx.traceId,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        availableAt: now,
        createdAt: now,
      },
    ],
    session ? { session } : {},
  );

  return eventId;
}

/* ── Relay-side operations ────────────────────────────────────────────────────
 * These take an explicit connection rather than reading the request context: the
 * relay is a background loop that walks every hospital in turn, so there is no
 * "current" tenant to speak of.
 */

/**
 * Atomically claims up to `limit` due events for one tenant.
 *
 * `findOneAndUpdate` in a loop, not `find` then `updateMany`: the read-then-write
 * version has a window in which two relay instances both see the same pending row.
 * The claim must be the same operation as the read, or it is not a claim.
 */
export async function claimDue(
  conn: Connection,
  tenantId: string,
  limit: number,
  staleClaimMs: number,
): Promise<OutboxEventDoc[]> {
  const model = getOutboxModel(conn);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - staleClaimMs);
  const claimed: OutboxEventDoc[] = [];

  for (let i = 0; i < limit; i++) {
    const doc = await model.findOneAndUpdate(
      {
        tenantId,
        availableAt: { $lte: now },
        $or: [
          { status: "pending" },
          // A relay that died mid-flight left rows in `processing` forever. Any
          // claim older than the stale window is assumed dead and reclaimed —
          // this is precisely why consumers must be idempotent: the original
          // relay may in fact have delivered it just before dying.
          { status: "processing", claimedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: "processing", claimedAt: now }, $inc: { attempts: 1 } },
      { new: true, sort: { availableAt: 1 } },
    );

    if (!doc) break;
    claimed.push(doc);
  }

  return claimed;
}

export async function markSent(conn: Connection, id: Types.ObjectId): Promise<void> {
  await getOutboxModel(conn).updateOne(
    { _id: id },
    { $set: { status: "sent", sentAt: new Date() }, $unset: { claimedAt: 1, lastError: 1 } },
  );
}

/** Back to `pending` with backoff, or to `failed` (the DLQ) once attempts run out. */
export async function markRetryOrFail(
  conn: Connection,
  doc: OutboxEventDoc,
  error: string,
  maxAttempts: number,
  backoffMs: number,
): Promise<"retry" | "failed"> {
  const exhausted = doc.attempts >= maxAttempts;

  await getOutboxModel(conn).updateOne(
    { _id: doc._id },
    {
      $set: {
        status: exhausted ? "failed" : "pending",
        availableAt: new Date(Date.now() + backoffMs),
        lastError: error.slice(0, 500),
      },
      $unset: { claimedAt: 1 },
    },
  );

  return exhausted ? "failed" : "retry";
}

/** Operator view: is anything stuck? Silent DLQ growth is an incident (ADR-0007). */
export async function outboxStats(
  conn: Connection,
  tenantId: string,
): Promise<Record<OutboxStatus, number>> {
  const rows = await getOutboxModel(conn).aggregate<{ _id: OutboxStatus; count: number }>([
    { $match: { tenantId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const stats: Record<OutboxStatus, number> = { pending: 0, processing: 0, sent: 0, failed: 0 };
  for (const row of rows) stats[row._id] = row.count;
  return stats;
}
