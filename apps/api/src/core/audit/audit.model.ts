/**
 * The audit trail (tenant DB `auditLogs`, Doc 03 §5.2, Doc 09 §9).
 *
 * WHY THIS LIVES IN `core` AND NOT IN A MODULE
 * --------------------------------------------
 * Audit is a cross-cutting concern, exactly like tenant scoping and logging: a
 * patients module that could *choose* whether to be audited would eventually
 * choose wrong. Doc 04 §2.2 places `auditPlugin` in core for that reason, so the
 * collection it writes to lives here too — a single append path that no module
 * can opt out of. The HTTP surface for *reading* the trail is `modules/audit`;
 * it reads this model and cannot write it.
 *
 * APPEND-ONLY IS ENFORCED IN CODE, NOT BY CONVENTION
 * -------------------------------------------------
 * An audit trail that can be edited by the same application that writes it is
 * not evidence — it is a diary. There is therefore no update or delete path:
 * every mutating query hook below throws, so even a future developer with good
 * intentions and a `findOneAndUpdate` cannot rewrite history through this model.
 * (A DBA with direct Mongo access still can, of course — that is what the hash
 * chain in `auditAnchor.ts` is for: it cannot prevent tampering, it makes
 * tampering *detectable*.)
 *
 * NO SOFT DELETE, NO `updatedAt`: both are meaningless on an immutable record,
 * and their presence would imply an editing story that does not exist. This is
 * why the model does NOT use `tenantScopePlugin` — it uses the narrower
 * `appendOnlyTenantPlugin` below, which stamps and enforces `tenantId` but adds
 * none of the mutable-document machinery.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { getContext } from "../context/requestContext.js";

/**
 * What kind of thing happened. Drives retention (DATA_RETENTION_POLICY) and the
 * filters a compliance officer actually uses — "show me every access to this
 * patient's chart" is a different question from "show me who changed a price".
 */
export const AUDIT_CATEGORIES = [
  /** Protected health information was created, changed or deleted. */
  "phi",
  /** Money: invoices, payments, refunds, tariffs, payroll. */
  "financial",
  /** Logins, MFA, session revocation, permission denials. */
  "security",
  /** Configuration: users, roles, plans, feature flags, branches. */
  "admin",
  /**
   * A sensitive record was *read* — HIPAA accounting of disclosures (Doc 09 §9).
   * Reads are not mutations, but "who opened this chart" is the question an
   * investigation actually asks, so it is audited like one.
   */
  "access",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_OUTCOMES = ["success", "failure"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditLogDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /**
   * Gap-free per-tenant sequence (see `nextAuditSeq`). Its whole purpose is that
   * a DELETED entry leaves a hole: without it, a deletion is invisible, because
   * the absence of a record looks exactly like the absence of an event.
   */
  seq: number;
  at: Date;
  /** SHA-256 of the canonical entry — the leaf the anchor chain is built from. */
  hash: string;

  actorId?: string;
  /** Denormalized: the actor may be renamed or deleted; the trail must still read. */
  actorEmail?: string;
  actorRoles?: string[];

  /** `resource.verb`, past tense-ish: `user.created`, `auth.login.failed`. */
  action: string;
  category: AuditCategory;
  resource: string;
  resourceId?: string;
  outcome: AuditOutcome;

  /** Changed fields only — never whole documents (see auditPlugin). */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Free-form context: the reason for an override, the denied permission, … */
  meta?: Record<string, unknown>;

  ip?: string;
  userAgent?: string;
  traceId?: string;
  branchId?: string;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    tenantId: { type: String, required: true },
    seq: { type: Number, required: true },
    at: { type: Date, required: true },
    hash: { type: String, required: true },

    actorId: { type: String },
    actorEmail: { type: String },
    /**
     * `default: undefined` is load-bearing, not decoration.
     *
     * Mongoose silently defaults an array path to `[]`. The leaf hash is computed
     * from the object we hand to `create()` — where an absent `actorRoles` is
     * `undefined` and contributes nothing — but the document that lands in Mongo
     * would carry `[]`, which canonicalizes differently. Verification would then
     * recompute a different hash and report TAMPERING on an entry nobody touched.
     *
     * A tamper-evident log that cries wolf is worse than one that does not exist:
     * the first false positive teaches everyone to ignore the alarm. (Caught by
     * sealing and verifying a real trail — it does not show up in a unit test that
     * hashes an object it never round-tripped through the database.)
     */
    actorRoles: { type: [String], default: undefined },

    action: { type: String, required: true },
    category: { type: String, enum: AUDIT_CATEGORIES, required: true },
    resource: { type: String, required: true },
    resourceId: { type: String },
    outcome: { type: String, enum: AUDIT_OUTCOMES, required: true, default: "success" },

    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },

    ip: { type: String },
    userAgent: { type: String },
    traceId: { type: String },
    branchId: { type: String },
  },
  // No `timestamps`: `at` is the event time and there is no update time, because
  // there are no updates. Indexes belong to migration 0003/0007 (Doc 03 §4).
  {
    timestamps: false,
    collection: "auditLogs",
    autoIndex: false,
    /**
     * ── `minimize: false` IS A TAMPER-EVIDENCE REQUIREMENT, NOT A PREFERENCE ──
     * Mongoose's default strips empty objects from a document on the way to the database. The leaf
     * hash is computed over the entry the writer BUILT, so a `before: {}` that Mongoose quietly
     * removed leaves a stored entry that can never recompute to its own hash — and
     * `verifyAuditChain` would report it as content-tampered, on an entry nobody touched.
     *
     * That is not hypothetical. Found on 2026-08-19 by the first test ever written against the
     * trail's contents: an update that only ADDS fields to a document (`transferredTo` and friends
     * appearing on an existing triage row) produces an empty `before` delta, because `diff` records
     * a previous value only where one existed. One entry in 202 failed to recompute, and it was
     * this. The audit log is a record, not a document to be tidied — it stores exactly what it was
     * handed, or the chain it anchors means nothing.
     */
    minimize: false,
  },
);

/**
 * Tenant scoping without the mutable-document machinery.
 *
 * Same guarantee as `tenantScopePlugin` — a query can never reach another
 * hospital's rows — but every write path other than insert is nailed shut.
 */
function appendOnlyTenantPlugin(schema: Schema): void {
  const readOps = ["find", "findOne", "countDocuments", "distinct"] as const;

  for (const op of readOps) {
    schema.pre(op, function (next) {
      const ctx = getContext();
      const query = this as unknown as {
        getQuery: () => Record<string, unknown>;
        setQuery: (q: Record<string, unknown>) => void;
      };
      const current = query.getQuery();
      if (current.tenantId !== undefined && current.tenantId !== ctx.tenantId) {
        next(new Error("tenant scope violation: audit query specified a foreign tenantId"));
        return;
      }
      query.setQuery({ ...current, tenantId: ctx.tenantId });
      next();
    });
  }

  schema.pre("aggregate", function (next) {
    const ctx = getContext();
    (this as unknown as { pipeline: () => unknown[] })
      .pipeline()
      .unshift({ $match: { tenantId: ctx.tenantId } });
    next();
  });

  const forbidden = [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "replaceOne",
    "deleteOne",
    "deleteMany",
  ] as const;

  for (const op of forbidden) {
    schema.pre(op, function (next) {
      next(
        new Error(
          `auditLogs is append-only (Doc 09 §9): "${op}" is not a legal operation on the audit trail. ` +
            "A correction is a NEW entry, never an edit to an old one.",
        ),
      );
    });
  }
}

auditLogSchema.plugin(appendOnlyTenantPlugin);

export function getAuditLogModel(conn: Connection): Model<AuditLogDoc> {
  return (
    (conn.models.AuditLog as Model<AuditLogDoc>) ??
    conn.model<AuditLogDoc>("AuditLog", auditLogSchema)
  );
}
