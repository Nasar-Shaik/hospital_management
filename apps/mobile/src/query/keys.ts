/**
 * Query keys — every branch-sensitive key begins `[tenantSlug, branchId]` (M0 §10).
 *
 * ── WHY THE PREFIX IS NOT OPTIONAL ──────────────────────────────────────────
 * The same query in two branches is two different answers. Without the branch in the key, the
 * cache returns the previous site's list for the first frame after a switch — and a list of the
 * wrong patients is a clinical error, not a rendering glitch. The tenant is in there for the same
 * reason one level up: a user who works at two hospitals must not see one's cache at the other.
 *
 * Keys are built here rather than inline so that "did this one get the prefix?" is answerable by
 * reading one file. `scoped()` is the only way to make a key, so forgetting is not possible.
 */

/** All-branches (aggregate) mode has to be a STABLE string, not `undefined` — an undefined
 *  segment collapses and `["apollo", undefined, "patients"]` would collide with `["apollo",
 *  "patients"]` under some serialisations. `"all"` is also what the API calls it. */
export const AGGREGATE = "all";

export interface QueryScope {
  tenantSlug: string;
  branchId?: string;
}

function prefix(scope: QueryScope): readonly [string, string] {
  return [scope.tenantSlug, scope.branchId ?? AGGREGATE] as const;
}

/** The general form. Feature modules use the named helpers below rather than calling this. */
export function scoped(
  scope: QueryScope,
  ...rest: readonly (string | number)[]
): readonly unknown[] {
  return [...prefix(scope), ...rest];
}

export const queryKeys = {
  /**
   * NOT branch-scoped, deliberately: who you are and what you may do does not change when you walk
   * between sites, and re-fetching it on every switch would put a round trip in front of a tap.
   */
  me: (tenantSlug: string) => [tenantSlug, "auth", "me"] as const,

  /**
   * Also not branch-scoped — this is the list the branch is CHOSEN from, so scoping it by the
   * current choice would make the switcher depend on the thing it sets.
   */
  myBranches: (tenantSlug: string) => [tenantSlug, "me", "branches"] as const,

  /* Everything below is branch-sensitive. M1 ships none of these screens; they are here so the
   * first feature to need one does not invent a key shape of its own. */
  patients: (scope: QueryScope, filters?: string) => scoped(scope, "patients", filters ?? ""),
  patient: (scope: QueryScope, id: string) => scoped(scope, "patients", id),
  encounters: (scope: QueryScope, filters?: string) => scoped(scope, "encounters", filters ?? ""),
  orders: (scope: QueryScope, filters?: string) => scoped(scope, "orders", filters ?? ""),
  notifications: (scope: QueryScope) => scoped(scope, "notifications"),
} as const;
