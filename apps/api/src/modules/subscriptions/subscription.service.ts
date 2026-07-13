/**
 * Subscriptions & editions (Doc 02 A2, Doc 07, ADR-0010 layer 1).
 *
 * ── THE COMMERCIAL RULE, AND THE CLINICAL ONE THAT OVERRIDES IT ──────────────
 * Limits are enforced at CREATION points only: adding user #26 on a 25-user plan
 * fails with HMS-PLAN-001 and an upgrade hint. They are never enforced mid-
 * workflow. A hospital that hits its bed limit must still be able to discharge a
 * patient, print a bill, or finish a consultation already in progress — blocking
 * those to force an upsell would put a commercial interest ahead of a clinical
 * one, which is the one thing this system must never do (Doc 07).
 *
 * Soft warning at 80%, hard block at 100%. The warning is surfaced in the usage
 * response so the UI can nudge before the wall arrives, rather than after.
 *
 * ── USAGE IS COUNTED, NOT TRUSTED ────────────────────────────────────────────
 * Anything cheap to count is counted live from the tenant's own data. A stored
 * counter can drift, and a drifted counter that says "26 users" when there are 20
 * would lock a hospital out of hiring — a self-inflicted outage in exchange for
 * saving a `countDocuments`. Counters are reserved for what genuinely cannot be
 * counted on demand (storage bytes, API calls).
 */
import { getEdition, type EditionDefinition } from "@medicore/permissions";
import { AppError } from "../../core/errors/appError.js";
import { cacheGet, cacheKeys, cacheSet, cacheDel } from "../../core/redis/redis.js";
import { env } from "../../config/env.js";
import { getById as getTenant } from "../tenants/index.js";
import { countUsers } from "../users/index.js";
import { invalidateFeatures } from "../entitlements/index.js";
import * as repo from "./subscription.repository.js";

/** Limits we can enforce today. Each needs a live count; add one only with its counter. */
export const LIMIT_METRICS = ["maxUsers"] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

const WARN_AT = 0.8;

export interface UsageLine {
  metric: LimitMetric;
  label: string;
  used: number;
  /** `null` means unlimited (Enterprise/contractual). */
  limit: number | null;
  /** 0–1, or null when unlimited. */
  ratio: number | null;
  /** True from 80% — the nudge, not the wall. */
  warning: boolean;
  /** True at 100% — the next creation will be refused. */
  exceeded: boolean;
}

export interface SubscriptionView {
  planCode: string | null;
  planName: string | null;
  features: string[];
  limits: EditionDefinition["limits"];
  usage: UsageLine[];
}

const LABELS: Record<LimitMetric, string> = {
  maxUsers: "Staff accounts",
};

/** The live count for a metric, inside the current tenant's context. */
async function currentUsage(metric: LimitMetric): Promise<number> {
  switch (metric) {
    case "maxUsers":
      // Archived users no longer occupy a seat — offboarding must free capacity,
      // or a hospital would eventually be unable to hire anyone ever again.
      return countUsers({ excludeStatuses: ["archived"] });
    default:
      return 0;
  }
}

function toLine(metric: LimitMetric, used: number, limit: number | undefined): UsageLine {
  // Absent or 0 means unlimited — `maxBeds: 0` on a clinic means "no beds", but a
  // missing seat limit on Enterprise means "as many as the contract says".
  const unlimited = limit === undefined;
  const ratio = unlimited || limit === 0 ? null : used / limit;

  return {
    metric,
    label: LABELS[metric],
    used,
    limit: unlimited ? null : limit,
    ratio,
    warning: ratio !== null && ratio >= WARN_AT && ratio < 1,
    exceeded: ratio !== null && ratio >= 1,
  };
}

/** The whole picture for the Subscription & usage screen. */
export async function getSubscription(tenantId: string): Promise<SubscriptionView> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });

  const edition = getEdition(tenant.planCode);

  const usage: UsageLine[] = [];
  for (const metric of LIMIT_METRICS) {
    usage.push(toLine(metric, await currentUsage(metric), edition?.limits[metric]));
  }

  return {
    planCode: tenant.planCode ?? null,
    planName: edition?.name ?? null,
    features: [...(edition?.flags ?? [])],
    limits: edition?.limits ?? {},
    usage,
  };
}

/**
 * The gate. Call BEFORE creating the thing, never after.
 *
 * Throws HMS-PLAN-001 (402) with the metric and the current numbers, so the UI
 * can say "25 of 25 staff accounts used — upgrade to add more" instead of a bare
 * "forbidden".
 */
export async function assertWithinLimit(tenantId: string, metric: LimitMetric): Promise<void> {
  const tenant = await getTenant(tenantId);
  const edition = getEdition(tenant?.planCode);
  const limit = edition?.limits[metric];

  if (limit === undefined) return; // unlimited / no plan configured

  const used = await currentUsage(metric);
  if (used < limit) return;

  throw new AppError("HMS-PLAN-001", 402, "Plan limit reached", {
    metric,
    used,
    limit,
    plan: tenant?.planCode,
    hint: "Upgrade the subscription to add more.",
  });
}

/** True once a tenant is at or past 80% — for the soft warning banner. */
export async function limitWarnings(tenantId: string): Promise<UsageLine[]> {
  const view = await getSubscription(tenantId);
  return view.usage.filter((line) => line.warning || line.exceeded);
}

/* ── plan administration ─────────────────────────────────────────────────── */

/**
 * Mirrors the code-defined edition catalog into the master `plans` collection.
 * Idempotent. Code stays the source of truth for what an edition unlocks; these
 * rows are what the platform prices and lists.
 */
export const seedPlans = repo.syncPlans;
export const listPlans = repo.listPlans;

/**
 * Changes a hospital's edition.
 *
 * A downgrade that would put the tenant OVER a limit is refused: silently leaving
 * a hospital with 40 staff on a 25-seat plan means either we do not enforce the
 * limit (so it means nothing) or we lock 15 people out of their jobs overnight.
 * Neither is acceptable, so the operator is told to reduce usage first.
 */
export async function changePlan(tenantId: string, planCode: string): Promise<SubscriptionView> {
  const edition = getEdition(planCode);
  if (!edition) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      planCode: [`unknown plan: ${planCode}`],
    });
  }

  for (const metric of LIMIT_METRICS) {
    const limit = edition.limits[metric];
    if (limit === undefined) continue;

    const used = await currentUsage(metric);
    if (used > limit) {
      throw new AppError("HMS-PLAN-001", 402, "Plan limit reached", {
        metric,
        used,
        limit,
        plan: planCode,
        hint: `This hospital already has ${String(used)} of these; ${edition.name} allows ${String(limit)}. Reduce usage before downgrading.`,
      });
    }
  }

  await repo.setTenantPlan(tenantId, planCode);

  // The flag set just moved. Both caches must go, in the method that made the
  // change — not fire-and-forget from a controller (CACHE_STRATEGY).
  await invalidateFeatures(tenantId);
  await cacheDel(cacheKeys.tenantBySlug((await getTenant(tenantId))?.slug ?? ""));

  return getSubscription(tenantId);
}

/** Cached usage snapshot for dashboards — never for the enforcement path. */
export async function getCachedUsage(tenantId: string): Promise<UsageLine[]> {
  const key = `usage:${tenantId}`;
  const cached = await cacheGet<UsageLine[]>(key);
  if (cached) return cached;

  const { usage } = await getSubscription(tenantId);
  await cacheSet(key, usage, Math.min(60, env.TENANT_CACHE_TTL_SECONDS));
  return usage;
}
