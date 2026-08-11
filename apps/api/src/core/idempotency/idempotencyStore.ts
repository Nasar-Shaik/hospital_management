/**
 * The idempotency-key store (tenant DB `idempotencyKeys`, Doc 03 §3/§5.2, Doc 04 §5.1).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * A cashier takes ₹5,000, the connection drops before the receipt renders, and the cashier —
 * having seen no receipt — takes it again. Two payments, one patient, and a reconciliation the
 * hospital will discover at the end of the month. The same shape kills in the other direction
 * too: a refund handed back twice is money out of the door.
 *
 * A disabled button does not fix this. The failure is a request that SUCCEEDED and whose answer
 * was lost, which is indistinguishable, from the client, from a request that never arrived. Only
 * the server can tell those apart, and only if the client names its intent — which is what
 * `Idempotency-Key` is: not "this HTTP call" but "this payment, the one I am submitting now".
 *
 * ── WHY A CLAIM AND NOT A LOOKUP ────────────────────────────────────────────
 * The tempting implementation is `if (!exists) execute()`. It is wrong, and wrong in exactly the
 * case it exists to cover: two identical requests in flight together both read "not found" and
 * both execute. The window is milliseconds and a double-click lands inside it.
 *
 * So the first thing a request does is INSERT a claim, and the unique index
 * `(tenantId, userId, key)` decides the winner. Exactly one insert survives; the loser is told
 * what happened to the winner. The database arbitrates, not the application.
 *
 * ── WHAT IS STORED, AND WHAT IS DELIBERATELY NOT ────────────────────────────
 * The request body is never stored — only a SHA-256 of it. A payment body is small but a
 * prescription body is PHI, and a table of request payloads with a 24-hour life is a second copy
 * of the medical record living somewhere nobody audits. The hash answers the only question the
 * store needs to ask ("is this the same request?") and answers nothing else.
 *
 * The RESPONSE is stored, because replaying it is the entire point, and it is the response the
 * caller has already been entitled to see. It is scoped to (tenant, user), lives 24 hours
 * (Doc 03 §7), and the TTL index from migration 0004 removes it without anybody running a job.
 */
import { createHash } from "node:crypto";
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { getContext, getTenantDb } from "../context/requestContext.js";
import { isDuplicateKey } from "../db/mongoErrors.js";

/**
 * 24 hours — Doc 03 §7 (`idem:{key}`, TTL 24h). Long enough to cover a phone that was retrying
 * from a train tunnel, short enough that the stored responses are not an archive.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claim may stay unfinished before another request may take it over.
 *
 * Without this, a process killed mid-payment leaves the key wedged for the full 24 hours and the
 * cashier cannot retry AT ALL — a safety mechanism that turns into an outage. 60 seconds is
 * comfortably past any request this API serves (the slowest money path is a two-document
 * transaction) and comfortably short of a cashier's patience.
 */
export const CLAIM_TIMEOUT_MS = 60_000;

/**
 * Key format. The existing per-module `requestId` fields already settled on 8–120 printable
 * characters (`order.schema.ts`, `billing.schema.ts`); this is the same rule with room for a
 * prefixed UUID. A minimum of 8 is not cosmetic — it refuses `"1"`, `"retry"` and the other
 * keys a hand-written client picks, which collide between users and across screens.
 */
export const KEY_MIN_LENGTH = 8;
export const KEY_MAX_LENGTH = 128;
const KEY_PATTERN = /^[\w.:@+-]+$/;

export function isWellFormedKey(key: string): boolean {
  return key.length >= KEY_MIN_LENGTH && key.length <= KEY_MAX_LENGTH && KEY_PATTERN.test(key);
}

export const IDEMPOTENCY_STATES = ["in_progress", "completed"] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

export interface IdempotencyRecordDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /**
   * The caller. Part of the identity of a key, not merely a label: two cashiers on two counters
   * will independently choose `"receipt-1"`, and if the store treated those as the same key the
   * second cashier would be handed the first one's receipt and the second patient's money would
   * never be taken.
   */
  userId: string;
  key: string;
  /** SHA-256 of the request — see `fingerprint()`. Never the request itself. */
  fingerprint: string;
  /** `POST /api/v1/invoices/:id/payments` — for the conflict message and the audit trail. */
  operation: string;
  state: IdempotencyState;
  /** The status and envelope actually sent, replayed verbatim. Only ever set for a 2xx. */
  responseStatus?: number;
  response?: unknown;
  claimedAt: Date;
  completedAt?: Date;
  expiresAt: Date;
}

const idempotencySchema = new Schema<IdempotencyRecordDoc>(
  {
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    operation: { type: String, required: true },
    state: { type: String, enum: IDEMPOTENCY_STATES, required: true, default: "in_progress" },
    responseStatus: { type: Number },
    response: { type: Schema.Types.Mixed },
    claimedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  /**
   * No `tenantScopePlugin`, for the same reason `outboxEvents` does without it: this is
   * infrastructure written by the HTTP layer, not a domain aggregate. It has no soft delete (a
   * TTL removes it), no audit trail (the mutation it guards has its own), and every read here
   * already leads with `tenantId` from the request context. The plugin's common fields would add
   * `isDeleted`/`version` columns nothing consults.
   */
  { collection: "idempotencyKeys", autoIndex: false },
);

export function getIdempotencyModel(conn: Connection): Model<IdempotencyRecordDoc> {
  return (
    (conn.models.IdempotencyRecord as Model<IdempotencyRecordDoc>) ??
    conn.model<IdempotencyRecordDoc>("IdempotencyRecord", idempotencySchema)
  );
}

/**
 * Recursively sorts object keys so two logically identical bodies hash identically.
 *
 * `{a:1,b:2}` and `{b:2,a:1}` are the same request, and a client that rebuilds its payload on
 * retry may well emit the keys in a different order — `JSON.stringify` would call that a
 * different request and refuse a legitimate retry with a 409.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((k) => [k, canonical(source[k])]),
    );
  }
  return value;
}

export interface FingerprintInput {
  method: string;
  /** The concrete path, ids and all — `/invoices/A/payments` is not `/invoices/B/payments`. */
  path: string;
  query: unknown;
  /** The VALIDATED body: Zod has already stripped unknown keys and applied defaults. */
  body: unknown;
  /** The branch this write lands in (ADR-0015). A different site is a different request. */
  branchId?: string;
}

/**
 * What makes two requests "the same".
 *
 * Everything a client controls that would change the outcome, and nothing else. In particular it
 * is built from the POST-VALIDATION body, so a retry that omits an optional field the schema
 * defaults, or adds a key the schema strips, still hashes the same — the fingerprint describes
 * the request the SERVER saw, which is the request that actually ran.
 *
 * There is nothing generated in here: no timestamp, no trace id, no random nonce. That is the
 * whole discipline. A fingerprint containing anything the client cannot reproduce would make
 * every legitimate retry look like a new request, and idempotency would silently do nothing —
 * failing open, on the money path, with a green test suite.
 */
export function fingerprint(input: FingerprintInput): string {
  const canon = canonical({
    method: input.method.toUpperCase(),
    path: input.path,
    query: input.query ?? {},
    body: input.body ?? null,
    branchId: input.branchId ?? null,
  });
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export interface ClaimInput {
  key: string;
  fingerprint: string;
  operation: string;
}

export type ClaimResult =
  /** This request won the claim and must execute. */
  | { outcome: "claimed"; recordId: Types.ObjectId; connection: Connection }
  /** The same request already completed — send this back, byte for byte. */
  | { outcome: "replay"; status: number; body: unknown; completedAt?: Date }
  /** The key was used for a DIFFERENT request. */
  | { outcome: "conflict"; record: IdempotencyRecordDoc }
  /** The same request is running right now, somewhere else. */
  | { outcome: "in_progress"; record: IdempotencyRecordDoc };

/**
 * Takes the key, or explains who has it.
 *
 * The insert is the concurrency primitive: `(tenantId, userId, key)` is unique, so of two
 * simultaneous identical requests exactly one insert succeeds and the other receives E11000.
 * Everything after the catch is the loser working out what to tell its caller.
 */
export async function claim(input: ClaimInput): Promise<ClaimResult> {
  const ctx = getContext();
  const userId = ctx.userId;
  if (!userId) {
    // Unreachable from a tagged route: `idempotent()` is only ever mounted behind
    // `authenticate()`. Asserted rather than assumed, because a key with no owner would be a
    // key shared by every caller in the hospital.
    throw new Error("idempotency requires an authenticated caller");
  }

  const connection = getTenantDb();
  const model = getIdempotencyModel(connection);
  const now = new Date();
  const identity = { tenantId: ctx.tenantId, userId, key: input.key };

  try {
    const created = await model.create({
      ...identity,
      fingerprint: input.fingerprint,
      operation: input.operation,
      state: "in_progress",
      claimedAt: now,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    });
    return { outcome: "claimed", recordId: created._id, connection };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const existing = await model.findOne(identity).lean<IdempotencyRecordDoc>();
  if (!existing) {
    /**
     * The row expired between our failed insert and this read — a 24-hour-old key retried at
     * exactly the wrong microsecond. Re-claiming is correct: no record means no previous result
     * to replay, so this request is, as far as anything can tell, the first one.
     */
    const created = await model.create({
      ...identity,
      fingerprint: input.fingerprint,
      operation: input.operation,
      state: "in_progress",
      claimedAt: now,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    });
    return { outcome: "claimed", recordId: created._id, connection };
  }

  /**
   * The fingerprint is checked FIRST, before the state, and the order is a safety property.
   * A key reused with a different body must never be answered with the old result — that is the
   * failure where a client's bug becomes a payment that silently did not happen. It is a
   * conflict whether the original finished or is still running.
   */
  if (existing.fingerprint !== input.fingerprint) {
    return { outcome: "conflict", record: existing };
  }

  if (existing.state === "completed") {
    return {
      outcome: "replay",
      status: existing.responseStatus ?? 200,
      body: existing.response,
      ...(existing.completedAt ? { completedAt: existing.completedAt } : {}),
    };
  }

  /**
   * An unfinished claim older than the timeout belonged to a process that died. Taking it over
   * is itself a race (two retries may arrive together), so it is an atomic conditional update:
   * the filter still requires `in_progress` AND the stale timestamp, so exactly one taker wins
   * and the other falls through to "in progress" — which is true, because the winner is running.
   */
  const cutoff = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const takenOver = await model.findOneAndUpdate(
    { ...identity, state: "in_progress", claimedAt: { $lt: cutoff } },
    { $set: { claimedAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } },
    { new: true },
  );
  if (takenOver) return { outcome: "claimed", recordId: takenOver._id, connection };

  return { outcome: "in_progress", record: existing };
}

/**
 * Records what the caller was sent, so the next retry gets the same answer.
 *
 * Scoped to the claim's own `_id` and to `state: "in_progress"`: if this claim was taken over as
 * stale while the handler was still running, the takeover owns the key and this write must not
 * overwrite its result with a stale one.
 */
export async function complete(
  connection: Connection,
  recordId: Types.ObjectId,
  status: number,
  body: unknown,
): Promise<void> {
  await getIdempotencyModel(connection).updateOne(
    { _id: recordId, state: "in_progress" },
    {
      $set: {
        state: "completed",
        responseStatus: status,
        response: body,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    },
  );
}

/**
 * Gives the key back after a failed request.
 *
 * Deliberately NOT recorded as a permanent answer. A 500 from a dropped database connection, a
 * 409 from a bed that has since been freed, a 402 the gateway will accept on the next attempt —
 * pinning any of those for 24 hours would convert a transient failure into an endpoint the
 * cashier cannot use for the rest of the day. Nothing was created, so nothing needs guarding;
 * the retry is a genuine first attempt.
 *
 * The per-module guards underneath (`orders.requestId`, `dispenses.requestId`, the atomic
 * `payments.requestId` filter) remain the last line if a handler ever fails AFTER writing.
 */
export async function release(connection: Connection, recordId: Types.ObjectId): Promise<void> {
  await getIdempotencyModel(connection).deleteOne({ _id: recordId, state: "in_progress" });
}
