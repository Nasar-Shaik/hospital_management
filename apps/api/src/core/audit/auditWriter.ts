/**
 * The ONE write path into the audit trail (Doc 09 §9).
 *
 * Two callers exist and no third should:
 *   1. `auditPlugin` — automatic, for every mutation of an audited collection.
 *   2. Services, for things that are not document mutations and therefore have no
 *      plugin to catch them: a login, a failed login, a permission denial, a plan
 *      change. These are exactly the events an investigator asks about first, and
 *      none of them is a `save()`.
 *
 * FAILURES ARE NOT SWALLOWED. If the audit write throws, the caller's request
 * fails. That is deliberate and it is the whole point (Doc 09 §9: "audit failures
 * fail the transaction — no unaudited mutations"). A system that silently drops
 * audit entries under load is worse than one with no audit at all, because it
 * produces a trail that is trusted and incomplete.
 *
 * When the caller is inside a transaction, pass its `session`: the audit entry
 * then commits or rolls back with the mutation it describes, so an aborted
 * transaction cannot leave behind a record of a change that never happened.
 */
import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { createLogger } from "@medicore/logger";
import { getContext, tryGetContext } from "../context/requestContext.js";
import { getAuditLogModel, type AuditCategory, type AuditOutcome } from "./audit.model.js";

const logger = createLogger({ service: "audit" });

/**
 * Never stored in the trail, whatever a caller passes. A password hash or a TOTP
 * seed in `before`/`after` would turn the audit log — the one collection we hand
 * to auditors and keep for years — into a credential store.
 */
const SECRET_FIELDS = new Set([
  "password",
  "passwordHash",
  "hash",
  "secret",
  "secretEncrypted",
  "totpSecret",
  "token",
  "tokenDigest",
  "refreshToken",
  "recoveryCodes",
  "apiKey",
]);

const REDACTED = "[redacted]";

/** Strips secrets at any depth. Values are compared by KEY, never by content. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELDS.has(key) ? REDACTED : redactSecrets(val);
  }
  return out;
}

/**
 * Deterministic serialization — the same entry must hash to the same bytes on
 * every machine, every Node version, forever, or the chain verifies as tampered
 * when nothing was tampered with. `JSON.stringify` is insertion-ordered, so keys
 * are sorted explicitly.
 */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * The exact fields the leaf hash covers — actor, action, target, diff, origin.
 *
 * ONE projection, used by BOTH the writer and the verifier. They must agree on
 * every field and every absent field, forever: if the writer hashes a field the
 * verifier does not project (or vice versa), every entry in the system reports as
 * tampered and the alarm becomes noise. Two hand-maintained field lists would
 * drift the first time somebody adds a column; this cannot.
 */
export interface AuditLeaf {
  tenantId: string;
  seq: number;
  at: Date;
  actorId?: string;
  actorEmail?: string;
  actorRoles?: string[];
  action: string;
  category: string;
  resource: string;
  resourceId?: string;
  outcome: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  traceId?: string;
  branchId?: string;
}

export function auditLeaf(doc: AuditLeaf): Record<string, unknown> {
  return {
    tenantId: doc.tenantId,
    seq: doc.seq,
    at: doc.at,
    actorId: doc.actorId,
    actorEmail: doc.actorEmail,
    actorRoles: doc.actorRoles,
    action: doc.action,
    category: doc.category,
    resource: doc.resource,
    resourceId: doc.resourceId,
    outcome: doc.outcome,
    before: doc.before,
    after: doc.after,
    meta: doc.meta,
    ip: doc.ip,
    userAgent: doc.userAgent,
    traceId: doc.traceId,
    branchId: doc.branchId,
  };
}

/** The leaf hash. Covers everything an entry asserts — actor, action, target, diff. */
export function hashAuditEntry(entry: AuditLeaf): string {
  return createHash("sha256")
    .update(canonical(auditLeaf(entry)))
    .digest("hex");
}

/**
 * Gap-free per-tenant sequence, from an atomic `$inc` on the tenant's own
 * `counters` document (Doc 03 §5.1).
 *
 * Why not just sort by `_id` or `at`? Because both can be forged or collide, and
 * neither makes a DELETION visible. A missing `seq` is a hole you cannot explain
 * away; a missing timestamp is just a quiet afternoon.
 *
 * This is a raw collection write on purpose: `counters` carries no schema, no
 * plugins, and must not be caught by the audit plugin (a counter bump is not an
 * auditable business event, and auditing it would recurse).
 */
export async function nextAuditSeq(session?: ClientSession): Promise<number> {
  const ctx = getContext();
  const result = await ctx.connection
    .collection<{ _id: string; tenantId: string; seq: number }>("counters")
    .findOneAndUpdate(
      { _id: "audit" },
      { $inc: { seq: 1 }, $setOnInsert: { tenantId: ctx.tenantId } },
      { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
    );

  const seq = result?.seq;
  if (typeof seq !== "number") {
    throw new Error("audit sequence allocation failed — refusing to write an unsequenced entry");
  }
  return seq;
}

export interface AuditInput {
  action: string;
  category: AuditCategory;
  resource: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /** Overrides the actor from context — used by the login path, where the actor is not yet authenticated. */
  actorId?: string;
  actorEmail?: string;
  branchId?: string;
}

export interface AuditEntry extends AuditInput {
  seq: number;
  at: Date;
  hash: string;
}

/**
 * Appends one entry. Returns it, so a caller that wants to assert on the trail
 * (tests, the anchor job) does not have to read it back.
 */
export async function recordAudit(input: AuditInput, session?: ClientSession): Promise<AuditEntry> {
  const ctx = getContext();

  const at = new Date();
  const seq = await nextAuditSeq(session);

  const body = {
    tenantId: ctx.tenantId,
    seq,
    at,
    actorId: input.actorId ?? ctx.userId,
    actorEmail: input.actorEmail ?? ctx.userEmail,
    actorRoles: ctx.roles,
    action: input.action,
    category: input.category,
    resource: input.resource,
    resourceId: input.resourceId,
    outcome: input.outcome ?? "success",
    before: input.before ? (redactSecrets(input.before) as Record<string, unknown>) : undefined,
    after: input.after ? (redactSecrets(input.after) as Record<string, unknown>) : undefined,
    meta: input.meta ? (redactSecrets(input.meta) as Record<string, unknown>) : undefined,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    traceId: ctx.traceId,
    branchId: input.branchId,
  };

  const hash = hashAuditEntry(body);

  await getAuditLogModel(ctx.connection).create([{ ...body, hash }], session ? { session } : {});

  return { ...input, seq, at, hash };
}

/**
 * Best-effort audit for paths where throwing would do more harm than the missing
 * entry — currently only the *rejection* paths (a failed login, a denied
 * permission), where the request is already being refused and a second failure
 * would replace a clean 401 with a confusing 500.
 *
 * NEVER use this for a mutation. If a change to PHI or money cannot be audited,
 * the change must not stand.
 */
export async function tryRecordAudit(input: AuditInput): Promise<void> {
  if (!tryGetContext()) return;
  try {
    await recordAudit(input);
  } catch (err) {
    // Swallowed for the response, NOT for the operator: a trail that is quietly
    // dropping entries has to be visible somewhere, and this is the somewhere.
    logger.error({ err, action: input.action }, "audit write failed — entry lost");
  }
}
