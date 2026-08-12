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

  /**
   * A patient's allergy list is read HOSPITAL-WIDE, not per site: the allergy routes are
   * `tenant`-scoped and `scopeFilter` deliberately does not narrow them (authorize.ts says so in
   * as many words). Prefixing this with a branch would claim a distinction the server does not
   * make, and would re-fetch the same rows on every switch — so it is keyed like `me`.
   *
   * This is the ONLY clinical key without a branch, and it is here rather than below so the
   * exception is impossible to miss.
   */
  patientAllergies: (tenantSlug: string, patientId: string) =>
    [tenantSlug, "patient", patientId, "allergies"] as const,

  /**
   * ── A LIST AND A RECORD NEVER SHARE A SEGMENT ───────────────────────────────
   * Lists are PLURAL (`"encounters"`), single records are SINGULAR (`"encounter"`). It reads
   * nicely and that is not why it is done.
   *
   * `encounters(scope)` with no filters is `[…, "encounters", ""]`. A detail key of
   * `[…, "encounters", id]` would be the SAME key whenever the id is `""` — which is exactly what
   * a screen passes while the route param is still resolving, or when a chart is opened with no
   * visit in context. The disabled detail query would then observe the LIST's cache entry and
   * hand a screen a `Paged<Encounter>` typed as an `Encounter`: no error, no failed request, just
   * a chart rendering fields that are not there. Different words, no collision, no thinking.
   */
  patients: (scope: QueryScope, filters?: string) => scoped(scope, "patients", filters ?? ""),
  patient: (scope: QueryScope, id: string) => scoped(scope, "patient", id),
  encounters: (scope: QueryScope, filters?: string) => scoped(scope, "encounters", filters ?? ""),
  orders: (scope: QueryScope, filters?: string) => scoped(scope, "orders", filters ?? ""),
  notifications: (scope: QueryScope) => scoped(scope, "notifications"),

  /* ── M2, the doctor's read-only surface ─────────────────────────────────── */

  /** One visit. */
  encounter: (scope: QueryScope, id: string) => scoped(scope, "encounter", id),
  /** Everyone in a bed right now (`GET /inpatients`) — feature-gated on `module.ops.ipd`. */
  inpatients: (scope: QueryScope) => scoped(scope, "inpatients"),
  /** One order, including its result once released. */
  order: (scope: QueryScope, id: string) => scoped(scope, "order", id),
  /** This visit's chart, oldest first. */
  encounterVitals: (scope: QueryScope, encounterId: string) =>
    scoped(scope, "encounter", encounterId, "vitals"),
  /** The patient's trend across visits, newest first. */
  patientVitals: (scope: QueryScope, patientId: string) =>
    scoped(scope, "patient", patientId, "vitals"),
  /** The structured note for one visit. `null` until the doctor starts one. */
  consultation: (scope: QueryScope, encounterId: string) =>
    scoped(scope, "encounter", encounterId, "consultation"),
  /** Prescriptions, filtered server-side; `filters` is the serialised query. */
  prescriptions: (scope: QueryScope, filters?: string) =>
    scoped(scope, "prescriptions", filters ?? ""),
  /** Every encounter in one care story (`GET /episodes/:id/timeline`). */
  episodeTimeline: (scope: QueryScope, episodeId: string) =>
    scoped(scope, "episode", episodeId, "timeline"),
} as const;
