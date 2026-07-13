/**
 * auditPlugin — audit as infrastructure, not as discipline (Doc 04 §2.2, Doc 09 §9).
 *
 * THE POINT OF A PLUGIN
 * ---------------------
 * Doc 09 §9 requires an audit entry for *every* mutation of PHI or financial
 * data. If that were a per-developer responsibility, coverage would be a function
 * of how tired the developer was — and the one path that gets missed will be the
 * one an investigation asks about. So a collection declares itself audited ONCE,
 * on its schema, and every write through Mongoose is recorded whether the author
 * remembered or not:
 *
 *     patientSchema.plugin(auditPlugin, { resource: "patient", category: "phi" });
 *
 * WHAT IS RECORDED
 * ----------------
 * Changed fields only — `before`/`after` hold the delta, not the whole document.
 * A full copy of every version of every chart would multiply the size of the
 * database by the number of edits, and would put a *second* full copy of PHI in a
 * collection with a much longer retention period than the record itself.
 *
 * SESSIONS
 * --------
 * The audit entry joins the caller's transaction when there is one (the document
 * or query carries the session). Once services adopt `withTransaction` for
 * multi-collection writes, audit becomes atomic with the mutation with no change
 * here — that is why the session is threaded through now, before it is needed.
 *
 * COST, HONESTLY
 * --------------
 * Update paths read the document before and after the write, so an audited update
 * costs three round trips instead of one. That is the price of knowing what
 * changed, and it is only paid by collections that opt in. Do not put this plugin
 * on high-churn operational collections (sessions, counters, queue rows) — audit
 * every mutation that a court could ask about, and nothing else.
 */
import type { ClientSession, Query, Schema, Types } from "mongoose";
import { tryGetContext } from "../../context/requestContext.js";
import { recordAudit } from "../../audit/auditWriter.js";
import type { AuditCategory } from "../../audit/audit.model.js";

export interface AuditPluginOptions {
  /** Singular, lowercase — `patient`, `invoice`, `user`. Appears in `action` and in filters. */
  resource: string;
  category: AuditCategory;
  /**
   * Fields never worth an audit entry on their own — bumping `lastLoginAt` is not
   * a chart amendment. A change to ONLY these fields records nothing.
   */
  ignore?: string[];
}

/** Mongoose bookkeeping — noise in a diff, and never what an investigator is looking for. */
const INTERNAL = new Set([
  "_id",
  "__v",
  "createdAt",
  "updatedAt",
  "tenantId",
  "version",
  "schemaVersion",
  "updatedBy",
]);

type Doc = Record<string, unknown>;

function isEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === b) return true;
  // Deep-compare the small, JSON-shaped values these documents actually hold.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The delta, both sides, changed keys only. */
function diff(
  before: Doc | undefined,
  after: Doc | undefined,
  ignore: Set<string>,
): { before: Doc; after: Doc; changed: string[] } {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const b: Doc = {};
  const a: Doc = {};
  const changed: string[] = [];

  const creating = before === undefined;

  for (const key of keys) {
    if (INTERNAL.has(key) || ignore.has(key)) continue;
    const from = before?.[key];
    const to = after?.[key];
    if (isEqual(from, to)) continue;

    // `isDeleted: false` on a brand-new document is the schema default, not a
    // decision anybody made. It still has to survive in the diff on UPDATE paths,
    // because flipping it to true IS the deletion — which is why this is scoped to
    // creation rather than added to INTERNAL.
    if (creating && key === "isDeleted" && to === false) continue;

    changed.push(key);
    if (from !== undefined) b[key] = from;
    if (to !== undefined) a[key] = to;
  }

  return { before: b, after: a, changed };
}

function idOf(doc: Doc | undefined): string | undefined {
  const id = doc?._id;
  return id ? (id as Types.ObjectId).toString() : undefined;
}

/** Mongoose reports "no session" as `null` on queries and `undefined` on documents. */
function sessionOf(session: ClientSession | null | undefined): ClientSession | undefined {
  return session ?? undefined;
}

/**
 * A soft delete is a `findOneAndUpdate` that flips `isDeleted`. Recording that as
 * "updated" would hide deletions from anyone filtering the trail for them — which
 * is precisely the filter a deletion investigation starts with.
 */
function verbFor(before: Doc | undefined, after: Doc | undefined): string {
  if (!before) return "created";
  if (!after) return "deleted";
  if (before.isDeleted !== true && after.isDeleted === true) return "deleted";
  if (before.isDeleted === true && after.isDeleted !== true) return "restored";
  return "updated";
}

export function auditPlugin(schema: Schema, options: AuditPluginOptions): void {
  const { resource, category } = options;
  const ignore = new Set(options.ignore ?? []);

  const write = async (
    before: Doc | undefined,
    after: Doc | undefined,
    session: ClientSession | undefined,
  ): Promise<void> => {
    // No context = seeding, migrations, CLI bootstrap. Those run before a tenant
    // request exists and are audited by the operator's own trail (the CLI logs),
    // not by this one. `getContext()` would throw and break provisioning.
    if (!tryGetContext()) return;

    const delta = diff(before, after, ignore);
    if (delta.changed.length === 0) return;

    const verb = verbFor(before, after);

    await recordAudit(
      {
        action: `${resource}.${verb}`,
        category,
        resource,
        resourceId: idOf(after ?? before),
        ...(before ? { before: delta.before } : {}),
        ...(after ? { after: delta.after } : {}),
        meta: { fields: delta.changed },
        ...(typeof (after ?? before)?.branchId === "string"
          ? { branchId: (after ?? before)?.branchId as string }
          : {}),
      },
      session,
    );
  };

  /* ── document path: new Model().save() and doc.save() ──────────────────── */

  schema.pre("save", async function (next) {
    const self = this as unknown as {
      isNew: boolean;
      _id: unknown;
      $locals: Doc;
      $session: () => ClientSession | undefined;
      constructor: { findById: (id: unknown) => { lean: () => Promise<Doc | null> } };
    };

    // Outside a tenant context (seeding, migrations) nothing will be recorded, so
    // do not pay for the pre-image read — and do not let the tenant-scoped read
    // throw during bootstrap, which would break provisioning.
    if (self.isNew || !tryGetContext()) {
      self.$locals.auditBefore = undefined;
      next();
      return;
    }

    // The pre-image. Mongoose does not keep one, so it has to be read.
    const previous = await self.constructor.findById(self._id).lean();
    self.$locals.auditBefore = previous ?? undefined;
    next();
  });

  schema.post("save", async function (doc: unknown) {
    const self = this as unknown as { $locals: Doc; $session: () => ClientSession | undefined };
    const after = (doc as { toObject: () => Doc }).toObject();
    await write(self.$locals.auditBefore as Doc | undefined, after, self.$session());
  });

  /* ── query path: findOneAndUpdate / updateOne / findOneAndDelete ────────── */

  type AuditQuery = Query<unknown, unknown> & {
    _auditBefore?: Doc | undefined;
  };

  const singleUpdateOps = ["findOneAndUpdate", "updateOne"] as const;

  for (const op of singleUpdateOps) {
    schema.pre(op, async function (next) {
      const query = this as AuditQuery;
      if (!tryGetContext()) {
        query._auditBefore = undefined;
        next();
        return;
      }
      const before = await query.model.findOne(query.getFilter()).lean();
      query._auditBefore = (before as Doc | null) ?? undefined;
      next();
    });

    schema.post(op, async function () {
      const query = this as AuditQuery;
      const before = query._auditBefore;
      if (!before) return; // upsert of a brand-new doc, or nothing matched

      // Re-read rather than trust the hook's argument: `findOneAndUpdate` without
      // `{ new: true }` hands back the PRE-image, and an audit trail that records
      // the old values as the new ones is worse than no trail.
      const after = await query.model.findById(before._id).lean();
      await write(
        before,
        (after as Doc | null) ?? undefined,
        sessionOf(query.getOptions().session),
      );
    });
  }

  const deleteOps = ["findOneAndDelete", "deleteOne"] as const;

  for (const op of deleteOps) {
    schema.pre(op, async function (next) {
      const query = this as AuditQuery;
      if (!tryGetContext()) {
        query._auditBefore = undefined;
        next();
        return;
      }
      const before = await query.model.findOne(query.getFilter()).lean();
      query._auditBefore = (before as Doc | null) ?? undefined;
      next();
    });

    schema.post(op, async function () {
      const query = this as AuditQuery;
      if (!query._auditBefore) return;
      await write(query._auditBefore, undefined, sessionOf(query.getOptions().session));
    });
  }

  /* ── bulk paths ─────────────────────────────────────────────────────────── */

  /**
   * `updateMany`/`deleteMany` are recorded as ONE entry carrying the filter and
   * the count, not as a diff per row: reading N documents twice to audit a bulk
   * write turns an administrative sweep into an outage.
   *
   * The consequence is deliberate and must be respected by callers: a bulk write
   * on PHI leaves a *weaker* trail than a per-row write. Clinical modules must not
   * mutate charts in bulk. Administrative sweeps (archiving, re-indexing) may.
   */
  const bulkOps = ["updateMany", "deleteMany"] as const;

  for (const op of bulkOps) {
    schema.post(op, async function (result: unknown) {
      if (!tryGetContext()) return;
      const query = this as AuditQuery;
      const counts = result as { modifiedCount?: number; deletedCount?: number };
      const affected = counts.deletedCount ?? counts.modifiedCount ?? 0;
      if (affected === 0) return;

      await recordAudit(
        {
          action: `${resource}.bulk.${op === "deleteMany" ? "deleted" : "updated"}`,
          category,
          resource,
          meta: {
            filter: query.getFilter() as Record<string, unknown>,
            affected,
            note: "bulk operation — per-row before/after is not captured",
          },
        },
        sessionOf(query.getOptions().session),
      );
    });
  }
}
