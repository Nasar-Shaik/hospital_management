/**
 * Audit read repository — the ONLY query path into the trail.
 *
 * It reads the model that `core/audit` owns and can only ever read it: the model
 * itself throws on every mutating operation, so "read-only" here is a property of
 * the code rather than a promise in a comment.
 */
import { getTenantDb } from "../../core/context/requestContext.js";
import {
  getAuditLogModel,
  type AuditCategory,
  type AuditLogDoc,
  type AuditOutcome,
} from "../../core/audit/audit.model.js";

/** What a reader of the trail is allowed to see (Doc 09 §5 — never the raw document). */
export interface AuditEntryView {
  id: string;
  seq: number;
  at: Date;
  actorId?: string;
  actorEmail?: string;
  actorRoles?: string[];
  action: string;
  category: AuditCategory;
  resource: string;
  resourceId?: string;
  outcome: AuditOutcome;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ip?: string;
  traceId?: string;
}

function toView(doc: AuditLogDoc): AuditEntryView {
  return {
    id: doc._id.toString(),
    seq: doc.seq,
    at: doc.at,
    ...(doc.actorId ? { actorId: doc.actorId } : {}),
    ...(doc.actorEmail ? { actorEmail: doc.actorEmail } : {}),
    ...(doc.actorRoles?.length ? { actorRoles: doc.actorRoles } : {}),
    action: doc.action,
    category: doc.category,
    resource: doc.resource,
    ...(doc.resourceId ? { resourceId: doc.resourceId } : {}),
    outcome: doc.outcome,
    ...(doc.before ? { before: doc.before } : {}),
    ...(doc.after ? { after: doc.after } : {}),
    ...(doc.meta ? { meta: doc.meta } : {}),
    ...(doc.ip ? { ip: doc.ip } : {}),
    ...(doc.traceId ? { traceId: doc.traceId } : {}),
  };
}

export interface AuditFilter {
  page: number;
  limit: number;
  category?: AuditCategory;
  action?: string;
  actorId?: string;
  resource?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
}

function buildQuery(filter: AuditFilter): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (filter.category) query.category = filter.category;
  if (filter.action) query.action = filter.action;
  if (filter.actorId) query.actorId = filter.actorId;
  if (filter.resource) query.resource = filter.resource;
  if (filter.resourceId) query.resourceId = filter.resourceId;
  if (filter.outcome) query.outcome = filter.outcome;
  if (filter.from || filter.to) {
    query.at = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lte: filter.to } : {}),
    };
  }
  return query;
}

export interface AuditPage {
  entries: AuditEntryView[];
  total: number;
}

export async function list(filter: AuditFilter): Promise<AuditPage> {
  const model = getAuditLogModel(getTenantDb());
  const query = buildQuery(filter);

  const [docs, total] = await Promise.all([
    model
      .find(query)
      // By `seq`, not by `at`: two entries written in the same millisecond have no
      // defined order by timestamp, and a trail whose order shifts between two
      // reads of the same page is a trail an auditor will not trust.
      .sort({ seq: -1 })
      .skip((filter.page - 1) * filter.limit)
      .limit(filter.limit),
    model.countDocuments(query),
  ]);

  return { entries: docs.map(toView), total };
}

/** Streams the matching entries for an export, oldest first (how evidence is read). */
export async function listForExport(
  filter: Omit<AuditFilter, "page" | "limit">,
  cap: number,
): Promise<AuditEntryView[]> {
  const docs = await getAuditLogModel(getTenantDb())
    .find(buildQuery(filter as AuditFilter))
    .sort({ seq: 1 })
    .limit(cap);
  return docs.map(toView);
}
