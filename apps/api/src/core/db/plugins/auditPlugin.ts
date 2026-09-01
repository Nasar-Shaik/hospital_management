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
 * WHAT COUNTS AS A FIRST WRITE
 * ---------------------------
 * **An audited first write performed by an upsert is recorded as a CREATE; every later mutation of
 * that document is recorded as an UPDATE.** This is stated because it was not true until
 * 2026-08-19: the query-path post hook returned early whenever there was no pre-image, so a
 * document whose first write happened through `findOneAndUpdate(..., { upsert: true })` never
 * appeared in the trail at all, while its second write did (risk register D17). The vocabulary did
 * not need extending to fix it — `verbFor` has always answered "created" for an absent pre-image;
 * the query path simply never reached it.
 *
 * The corollary is a rule on CALLERS, enforced by
 * `auditedUpsertsReturnTheNewDocument.test.ts`: an upsert on an audited collection must ask for
 * the new document (`new: true`), because that is the only way the driver reports an insert
 * without a second query that could see somebody else's row. See the comment on `createdIdFrom`.
 *
 * COST, HONESTLY
 * --------------
 * Update paths read the document before and after the write, so an audited update
 * costs three round trips instead of one. A create through an upsert now costs
 * two — the pre-image read that finds nothing, and one read of the new document
 * by the id the driver reported. That is the price of knowing what changed, and
 * it is only paid by collections that opt in. Do not put this plugin on
 * high-churn operational collections (sessions, counters, queue rows) — audit
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

    /**
     * An EMPTY side is not written. `diff` records a previous value only where one existed, so an
     * update that merely ADDS fields — `transferredTo` appearing on a triage row that never had
     * one — produces `before: {}`. Storing that says "the previous version had no fields", which
     * is false and is not what the delta means; absence says "none of the changed fields had a
     * previous value", which is exactly what happened, and it matches how a CREATE already reads.
     *
     * It also used to break the chain. The hash covers the entry as BUILT, and Mongoose's default
     * `minimize` stripped the empty object on the way to the database, so the stored entry could
     * never recompute to its own hash. `audit.model.ts` now sets `minimize: false` so storage
     * cannot alter what was hashed; this makes sure the value was worth storing in the first place.
     */
    const sideOf = (delta: Doc): Doc | undefined =>
      Object.keys(delta).length > 0 ? delta : undefined;

    await recordAudit(
      {
        action: `${resource}.${verb}`,
        category,
        resource,
        resourceId: idOf(after ?? before),
        ...(before && sideOf(delta.before) ? { before: delta.before } : {}),
        ...(after && sideOf(delta.after) ? { after: delta.after } : {}),
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

  /**
   * The id of a document this write CREATED, or undefined if it created none.
   *
   * ── WHY THE DRIVER'S OWN ANSWER, AND NOT A SECOND QUERY (D17) ─────────────
   * When the pre-hook found no document, two very different things may have happened: an upsert
   * INSERTED one, or the filter matched nothing and the write was a no-op. Auditing both would
   * invent events for writes that never occurred; auditing neither is the bug this replaces — the
   * post hook used to `return` on a missing pre-image, so **the first write of any document
   * created by an upsert was never recorded at all.** The first ED triage of a patient produced
   * no audit row; only a later re-triage did.
   *
   * The two cases are told apart by what the driver reports, not by re-reading the collection and
   * guessing. Measured against Mongoose 8.13 / Mongo 7:
   *
   *   findOneAndUpdate + `new: true`  → the document, on both insert and update
   *   findOneAndUpdate, no `new`      → **null on insert**, indistinguishable from a no-op
   *   updateOne + upsert              → UpdateResult carrying `upsertedId` on insert only
   *   nothing matched, no upsert      → null / an all-zero UpdateResult
   *
   * A re-read keyed on the FILTER would have covered the third case too, and it is exactly what
   * this must not do: under a concurrent insert it would attribute another caller's document to
   * this one, which is the single thing an audit trail may never get wrong. So the blind case is
   * closed at the call sites instead — an audited upsert must ask for the new document, and
   * `auditedUpsertsReturnTheNewDocument.test.ts` fails the build if one stops.
   */
  const createdIdFrom = (result: unknown): unknown => {
    if (result === null || typeof result !== "object") return undefined;
    const asUpdate = result as { upsertedId?: unknown };
    if (asUpdate.upsertedId != null) return asUpdate.upsertedId;
    const asDoc = result as { _id?: unknown };
    return asDoc._id ?? undefined;
  };

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

    schema.post(op, async function (result: unknown) {
      const query = this as AuditQuery;

      // Seeding, migrations, CLI bootstrap. `write` would return anyway; checking here keeps the
      // extra read below off the provisioning path, which upserts a whole catalogue per tenant.
      if (!tryGetContext()) return;

      const session = sessionOf(query.getOptions().session);
      const before = query._auditBefore;

      if (before) {
        // Re-read rather than trust the hook's argument: `findOneAndUpdate` without
        // `{ new: true }` hands back the PRE-image, and an audit trail that records
        // the old values as the new ones is worse than no trail.
        const after = await query.model.findById(before._id).lean();
        await write(before, (after as Doc | null) ?? undefined, session);
        return;
      }

      const created = createdIdFrom(result);
      if (created == null) return; // nothing matched and nothing was inserted — no event

      /**
       * Read the document back rather than using the returned one, for the same reason the update
       * path does: the shape the driver hands back varies with the caller's options, and the trail
       * must not vary with them. Keyed on `_id`, so this cannot pick up somebody else's row.
       *
       * If it has already been deleted by the time we look, record nothing. Inventing a create for
       * a document we cannot describe would put a row in the trail that no investigator can follow.
       */
      const after = await query.model.findById(created).lean();
      if (!after) return;
      await write(undefined, after as Doc, session);
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
