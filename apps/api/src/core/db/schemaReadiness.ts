/**
 * CAN THIS DATABASE STILL ENFORCE THE RULE, RIGHT NOW? — the runtime half of the schema guard.
 *
 * ── WHY THE DEPLOYMENT GATE IS NOT ENOUGH ON ITS OWN ────────────────────────
 * `migrate --check` answers for the whole fleet, thoroughly, at the moment somebody runs it. Two
 * things make that insufficient for medication administration specifically:
 *
 *   1. Nobody has to run it. There is no deployment pipeline in this repository — Dockerfiles and
 *      no orchestration — so "the operator ran the gate" is the entire control.
 *
 *   2. **The damage is irreversible.** Measured on 2026-08-16: with the dose-slot index absent, two
 *      administrations of the same slot are both accepted; and once that duplicate pair exists the
 *      unique index CANNOT be rebuilt (the build fails E11000). The MAR is append-only, so the only
 *      way back is deleting a clinical record — which Constitution §3.9 forbids. A drift window does
 *      not merely risk harm; harm inside it becomes permanent.
 *
 * It is also invisible where it matters: `slotsForStay` keys administrations into a `Map` by slot
 * identity, last write wins, so a double dose does not appear on the round or the ward worklist.
 *
 * ── WHY NOT PER REQUEST, AND WHY NOT REDIS ──────────────────────────────────
 * Per request would add a round trip to every clinical write for a condition that changes maybe
 * once a year. Redis is excluded by a governing rule — CACHE_STRATEGY: "Redis is never a source of
 * truth — a flushed Redis degrades latency, never correctness." A readiness verdict that Redis
 * could lose is exactly a correctness value in a cache.
 *
 * Connection-scoped caching was the tempting third option and is unsafe: the pool refreshes
 * `lastUsed` on every use, so a BUSY tenant's connection never evicts — the hospital where a double
 * dose matters most would hold the stalest answer, potentially for days.
 *
 * So: an in-process map with a short TTL. One inspection per tenant per minute (about 8 index reads
 * at current fleet size), no network on the hot path, no shared store to lose, and a staleness bound
 * that is stated rather than emergent. 60s matches MAINTENANCE_MODE's "effective ≤ 60 s".
 */
import type { Connection } from "mongoose";
import {
  CLINICAL_SAFETY_INVARIANTS,
  inspectInvariants,
  invariantsFor,
  type ClinicalCapability,
  type MissingInvariant,
  type SafetyInvariant,
} from "./clinicalInvariants.js";

/**
 * How long a verdict is trusted.
 *
 * This is the window in which drift is not yet noticed, so it is a safety parameter, not a
 * performance one. A minute is short enough that a dropped index is caught within one round's worth
 * of doses, and long enough that the check costs nothing measurable.
 */
export const READINESS_TTL_MS = 60_000;

interface CacheEntry {
  checkedAt: number;
  /** Every declared invariant that was NOT armed at `checkedAt`. Empty means fully armed. */
  missing: MissingInvariant[];
}

/**
 * Keyed by tenant id. A verdict about one hospital must never answer for another — the databases
 * are physically separate and so are their schemas.
 */
const cache = new Map<string, CacheEntry>();

export interface CapabilityReadiness {
  safe: boolean;
  /** The constraints that are absent. Empty when `safe`, or when the check could not run. */
  missing: MissingInvariant[];
  /** Set when the database could not be inspected — this is NOT a finding about the schema. */
  unknown?: string;
}

/**
 * Is every constraint these capabilities rest on actually armed in this tenant's database?
 *
 * `db` must be the connection for `tenantId`; the caller holds both and passing them separately is
 * what keeps this function testable. There is exactly one production call site, and the tenant
 * isolation it depends on is asserted directly in the tests.
 *
 * ── FAILING CLOSED, NARROWLY ──────────────────────────────────────────────
 * If the inspection itself fails, the honest answer is "unknown", and unknown must not become
 * "safe" for a safety-critical write. But it is scoped to the capabilities ASKED ABOUT and nothing
 * else, and it is deliberately NOT cached: a cached failure would keep refusing for a full TTL
 * after the database recovered, turning a blip into a minute of refused care.
 */
export async function tenantSchemaReadiness(
  tenantId: string,
  db: Connection,
  capabilities: readonly ClinicalCapability[],
  options: {
    now?: number;
    ttlMs?: number;
    invariants?: readonly SafetyInvariant[];
  } = {},
): Promise<CapabilityReadiness> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? READINESS_TTL_MS;
  const declared = options.invariants ?? CLINICAL_SAFETY_INVARIANTS;
  const required = invariantsFor(capabilities, declared);

  const cached = cache.get(tenantId);
  if (cached && now - cached.checkedAt < ttl) {
    return verdict(cached.missing, required);
  }

  let missing: MissingInvariant[];
  try {
    // Every declared invariant is inspected, not just the ones asked for: the cost is the same
    // handful of reads, and it means the next capability to be protected is already answered.
    missing = await inspectInvariants(db, declared);
  } catch (err) {
    return {
      safe: false,
      missing: [],
      unknown: err instanceof Error ? err.message : String(err),
    };
  }

  cache.set(tenantId, { checkedAt: now, missing });
  return verdict(missing, required);
}

function verdict(
  missing: readonly MissingInvariant[],
  required: readonly SafetyInvariant[],
): CapabilityReadiness {
  const relevant = missing.filter((m) => required.includes(m.invariant));
  return { safe: relevant.length === 0, missing: relevant };
}

/**
 * Drops a tenant's cached verdict, or all of them.
 *
 * For tests and for the moment a tenant is knowingly repaired — not a general invalidation
 * mechanism, because nothing inside this process can observe an index being dropped outside it.
 * The TTL is what actually bounds staleness.
 */
export function forgetSchemaReadiness(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}
