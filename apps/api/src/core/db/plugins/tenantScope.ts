/**
 * tenantScopePlugin — defense in depth (Doc 03 §1.3).
 *
 * Physical isolation (one DB per tenant) is the primary guarantee. This plugin is
 * the belt-and-braces layer: it stamps `tenantId` on every insert and verifies it
 * on every read/write, so a mis-resolved connection surfaces as a loud error
 * instead of a silent cross-tenant leak. It also applies the common fields and
 * the soft-delete filter (Doc 03 §1.4, Doc 09 §10).
 */
import type { Schema } from "mongoose";
import { getContext, tryGetContext } from "../../context/requestContext.js";

/** Common fields carried by every tenant-scoped collection (Doc 03 §1.4). */
export function applyCommonFields(schema: Schema): void {
  schema.add({
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String, index: true },
    createdBy: { type: String },
    updatedBy: { type: String },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    version: { type: Number, default: 0 },
    schemaVersion: { type: Number, default: 1 },
  });
}

export function tenantScopePlugin(schema: Schema): void {
  applyCommonFields(schema);

  /**
   * Stamp tenantId on create; reject a document belonging to another tenant.
   *
   * This MUST be `pre("validate")`, not `pre("save")`: Mongoose runs schema
   * validation before save hooks, so a stamp applied in pre-save arrives after
   * `required: true` has already failed. (Caught by the isolation suite.)
   */
  schema.pre("validate", function (next) {
    const ctx = getContext();
    const doc = this as unknown as { tenantId?: string };
    if (!doc.tenantId) {
      doc.tenantId = ctx.tenantId;
    } else if (doc.tenantId !== ctx.tenantId) {
      next(
        new Error(
          `tenant scope violation: document tenantId=${doc.tenantId} but context tenantId=${ctx.tenantId}`,
        ),
      );
      return;
    }
    next();
  });

  // Force tenant scope + soft-delete filter onto every query.
  const queryOps = [
    "find",
    "findOne",
    "findOneAndUpdate",
    "findOneAndDelete",
    "countDocuments",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
  ] as const;

  for (const op of queryOps) {
    schema.pre(op, function (next) {
      const ctx = getContext();
      const query = this as unknown as {
        getQuery: () => Record<string, unknown>;
        setQuery: (q: Record<string, unknown>) => void;
        getOptions: () => Record<string, unknown>;
      };
      const current = query.getQuery();

      // A caller may not query another tenant, even explicitly.
      if (current.tenantId !== undefined && current.tenantId !== ctx.tenantId) {
        next(new Error("tenant scope violation: query specified a foreign tenantId"));
        return;
      }

      const scoped: Record<string, unknown> = { ...current, tenantId: ctx.tenantId };
      // Soft-deleted docs are invisible unless explicitly requested (Doc 09 §10).
      if (scoped.isDeleted === undefined && query.getOptions().withDeleted !== true) {
        scoped.isDeleted = false;
      }
      query.setQuery(scoped);
      next();
    });
  }

  // Aggregations are scoped by prepending a $match stage.
  schema.pre("aggregate", function (next) {
    const ctx = getContext();
    const pipeline = (this as unknown as { pipeline: () => unknown[] }).pipeline();
    pipeline.unshift({ $match: { tenantId: ctx.tenantId, isDeleted: { $ne: true } } });
    next();
  });

  // Insert-many bulk path.
  schema.pre("insertMany", function (next, docs: unknown) {
    const ctx = tryGetContext();
    if (!ctx) {
      next(new Error("insertMany outside a tenant context"));
      return;
    }
    if (Array.isArray(docs)) {
      for (const doc of docs as Array<{ tenantId?: string }>) {
        doc.tenantId ??= ctx.tenantId;
        if (doc.tenantId !== ctx.tenantId) {
          next(new Error("tenant scope violation in insertMany"));
          return;
        }
      }
    }
    next();
  });
}
