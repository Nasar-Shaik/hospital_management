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
import { recordAudit } from "../../core/audit/auditWriter.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { cacheGet, cacheKeys, cacheSet, cacheDel } from "../../core/redis/redis.js";
import { env } from "../../config/env.js";
import { getById as getTenant, branchLimit as branchLimitFor } from "../tenants/index.js";
import { invalidateFeatures } from "../entitlements/index.js";
import { COUNTERS } from "./subscription.counters.js";
import * as repo from "./subscription.repository.js";

/**
 * Everything the Subscription & usage screen reports a live number for.
 *
 * ── COUNTED IS NOT THE SAME AS ENFORCED, AND THE SCREEN MUST SAY WHICH ──────
 * A progress bar with a limit under it reads as a wall. Only `maxUsers` and `maxBranches`
 * actually refuse a creation today; doctors and beds are counted and shown because a hospital
 * administrator asks "how many can I add?" — but nothing stops them, and drawing an identical
 * bar for all four would be inventing three walls that do not exist. Each line carries
 * `enforced`, and the UI says so out loud.
 *
 * Adding a metric here needs a live COUNTER (never a stored one — a drifted counter that
 * over-reports locks a hospital out of hiring). Moving one into `ENFORCED_METRICS` needs a
 * creation point to refuse at, and is a commercial decision, not a display one.
 */
export const USAGE_METRICS = ["maxUsers", "maxDoctors", "maxBranches", "maxBeds"] as const;
export type LimitMetric = (typeof USAGE_METRICS)[number];

/**
 * The metrics the API genuinely refuses a creation on.
 *
 * `maxUsers` is refused by `assertWithinLimit` in front of account creation; `maxBranches` by
 * the branch service, against the PLATFORM cap on the master record rather than the edition's
 * catalogue figure (see `branchLimitFor`). Everything else is a meter.
 */
const ENFORCED_METRICS = new Set<LimitMetric>(["maxUsers", "maxBranches"]);

/**
 * The metrics a plan CHANGE is checked against — see `changePlan`.
 *
 * Only the ones whose limit actually comes from the edition and is actually enforced, which is
 * `maxUsers` alone. `maxBranches` is deliberately absent: its cap is the tenant's platform
 * override, which a plan change does not touch, so refusing a downgrade against the edition's
 * catalogue number would block a change that does not alter the wall.
 */
export const LIMIT_METRICS = ["maxUsers"] as const;

const WARN_AT = 0.8;

export interface UsageLine {
  metric: LimitMetric;
  label: string;
  used: number;
  /** `null` means unlimited (Enterprise/contractual). Zero means NOT INCLUDED — see `included`. */
  limit: number | null;
  /** 0–1, or null when unlimited. */
  ratio: number | null;
  /** True from 80% — the nudge, not the wall. */
  warning: boolean;
  /** True at 100% — the next creation will be refused, IF this metric is enforced. */
  exceeded: boolean;
  /**
   * Does hitting this limit actually stop anything? False means the figure is for guidance —
   * counted and shown, but no creation point refuses on it. The UI must not draw it as a wall.
   */
  enforced: boolean;
  /**
   * False when the plan allows NONE of this (`limit: 0` — beds on a clinic edition). Distinct
   * from "at your limit": nothing was used up, the plan simply does not sell it, and rendering
   * it as a full red bar would tell a clinic it has run out of beds it never bought.
   */
  included: boolean;
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
  maxDoctors: "Doctors",
  maxBranches: "Branches",
  maxBeds: "Beds",
};

/**
 * The live count for a metric, inside the current tenant's context.
 *
 * WHAT is counted lives in `subscription.counters.ts` — the one product-specific file here.
 */
async function currentUsage(metric: LimitMetric): Promise<number> {
  return COUNTERS[metric]();
}

/**
 * The limit in force for a metric — the number the hospital will actually be held to.
 *
 * `maxBranches` is the one that does not come from the edition: it is a per-tenant platform cap
 * on the master record, and it is what `createBranch` refuses against. Reading the edition's
 * catalogue figure here would print a number the API does not honour, in either direction.
 */
async function limitFor(
  metric: LimitMetric,
  tenantId: string,
  edition: EditionDefinition | undefined,
): Promise<number | undefined> {
  if (metric === "maxBranches") return branchLimitFor(tenantId);
  return edition?.limits[metric];
}

function toLine(metric: LimitMetric, used: number, limit: number | undefined): UsageLine {
  // Absent means unlimited — a missing seat limit on Enterprise means "as many as the contract
  // says". Zero is the opposite and is handled separately: `maxBeds: 0` on a clinic means the
  // plan includes no beds at all.
  const unlimited = limit === undefined;
  const included = unlimited || limit > 0;
  const ratio = unlimited || limit === 0 ? null : used / limit;

  return {
    metric,
    label: LABELS[metric],
    used,
    limit: unlimited ? null : limit,
    ratio,
    warning: ratio !== null && ratio >= WARN_AT && ratio < 1,
    exceeded: ratio !== null && ratio >= 1,
    enforced: ENFORCED_METRICS.has(metric),
    included,
  };
}

/** The whole picture for the Subscription & usage screen. */
export async function getSubscription(tenantId: string): Promise<SubscriptionView> {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });

  const edition = getEdition(tenant.planCode);

  const usage: UsageLine[] = [];
  for (const metric of USAGE_METRICS) {
    const limit = await limitFor(metric, tenantId, edition);
    usage.push(toLine(metric, await currentUsage(metric), limit));
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

  /**
   * A hospital that has hit a wall is a fact worth knowing on both sides: the
   * administrator wants to be told before they discover it while onboarding a
   * nurse, and we would rather call them than have them call us.
   *
   * Published on every blocked attempt, so a client retrying in a loop produces a
   * burst. Deduplication belongs to the CONSUMER (EVENT_CATALOG: "dedupe per
   * metric+period") — squashing it here would need state that the enforcement
   * path has no business owning, and this path must stay fast and simple: it sits
   * in front of every account creation in the system.
   */
  await publish({
    name: EVENTS.LIMIT_THRESHOLD_REACHED,
    payload: { metric, used, limit, pct: 100, plan: tenant?.planCode },
  });

  throw new AppError("HMS-PLAN-001", 402, "Plan limit reached", {
    metric,
    used,
    limit,
    plan: tenant?.planCode,
    hint: "Upgrade the subscription to add more.",
  });
}

/**
 * True once a tenant is at or past 80% — for the soft warning banner.
 *
 * ENFORCED metrics only. "You are approaching your limit" is a warning that something is about to
 * stop working; saying it about a figure nothing refuses on would train people to ignore the ones
 * that mean it.
 */
export async function limitWarnings(tenantId: string): Promise<UsageLine[]> {
  const view = await getSubscription(tenantId);
  return view.usage.filter((line) => line.enforced && (line.warning || line.exceeded));
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

  const before = await getTenant(tenantId);
  const fromPlan = before?.planCode;

  await repo.setTenantPlan(tenantId, planCode);

  // The flag set just moved. Both caches must go, in the method that made the
  // change — not fire-and-forget from a controller (CACHE_STRATEGY).
  await invalidateFeatures(tenantId);
  await cacheDel(cacheKeys.tenantBySlug(before?.slug ?? ""));

  /**
   * Audited as `admin`, not published-and-forgotten. A2 taught this the hard way:
   * `plan:manage` was briefly reachable by a hospital's own administrator, and the
   * only reason we could be certain no customer had used it was that the fleet was
   * still ours. Once there are real customers, "did anyone upgrade themselves"
   * must be answerable from the trail, not from memory.
   */
  await recordAudit({
    action: "subscription.planChanged",
    category: "admin",
    resource: "subscription",
    resourceId: tenantId,
    before: { planCode: fromPlan },
    after: { planCode },
    meta: { features: edition.flags.length },
  });

  /**
   * NOT atomic with the write above, and it cannot be: the plan lives in the
   * MASTER database and the outbox lives in the tenant's. A crash between the two
   * loses the notification, never the plan change — the registry stays the source
   * of truth, and a consumer that missed the event re-reads it on the next request
   * (entitlement caches are TTL'd at 5 minutes anyway). A master-side outbox would
   * close the gap; it is not worth a second relay loop for a handful of events a
   * month, and this comment is here so that trade-off is a decision rather than an
   * oversight.
   */
  await publish({
    name: EVENTS.SUBSCRIPTION_CHANGED,
    payload: { tenantId, fromPlan, toPlan: planCode },
  });

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
