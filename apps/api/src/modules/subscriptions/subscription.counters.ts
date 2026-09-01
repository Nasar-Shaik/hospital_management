/**
 * WHAT EACH METERED LIMIT COUNTS — the one product-specific file in this module.
 *
 * ── WHY THIS IS A SEPARATE FILE ─────────────────────────────────────────────
 * `subscriptions` is a PLATFORM module (PLATFORM_STRATEGY §2): the arithmetic of a limit —
 * counted vs. capped, the 80% nudge, unlimited vs. not-included — is the same whether the
 * product sells hospital beds or school classrooms. What is NOT the same is what a "bed" is.
 *
 * So the generic half stays in `subscription.service.ts` and every healthcare-shaped dependency
 * lives HERE, behind one map, where it can be read at a glance and swapped whole for another
 * product. The alternative — a runtime registry other modules populate at boot — buys the same
 * decoupling and costs the ability to see, in one screen, what the plan screen actually counts.
 *
 * ── EVERY COUNT IS LIVE ─────────────────────────────────────────────────────
 * Nothing here reads a stored counter. A drifted counter that over-reports would lock a hospital
 * out of hiring, and `countDocuments` on a directory-sized collection is not the cost that
 * matters. (Storage bytes would need a real counter — which is exactly why `storageGb` is shown
 * as a plan allowance and NOT metered here: there is nothing counting it, and a meter with no
 * counter behind it would read "0 GB used" over a hospital with a full disk.)
 */
import { countUsers } from "../users/index.js";
import { countBranches } from "../branches/index.js";
import { countBeds } from "../wards/index.js";
import { listUserIdsWithRoleCode } from "../rbac/index.js";

/**
 * The role that makes someone a doctor for LICENSING purposes.
 *
 * The seeded system role, not a permission: a plan sells "10 doctors", and what a hospital means
 * by that is the people on the medical register, not everyone who happens to hold `emr:write`.
 */
const DOCTOR_ROLE = "DOCTOR";

/** How many of each thing this hospital has right now. Runs inside the tenant's own context. */
export const COUNTERS = {
  /**
   * Archived users no longer occupy a seat — offboarding must free capacity, or a hospital would
   * eventually be unable to hire anyone ever again.
   */
  maxUsers: () => countUsers({ excludeStatuses: ["archived"] }),

  /**
   * RBAC says who holds the role; `users` says which of those are still accounts. Neither module
   * learns the other's vocabulary, and an archived doctor frees their place for the same reason
   * an archived user frees a seat.
   */
  maxDoctors: async () => {
    const ids = await listUserIdsWithRoleCode(DOCTOR_ROLE);
    if (ids.length === 0) return 0;
    return countUsers({ ids, excludeStatuses: ["archived"] });
  },

  maxBranches: () => countBranches(),

  /** Across every site: a bed allowance is bought by the hospital, not by the site. */
  maxBeds: () => countBeds(),
} as const satisfies Record<string, () => Promise<number>>;

export type MeteredMetric = keyof typeof COUNTERS;
