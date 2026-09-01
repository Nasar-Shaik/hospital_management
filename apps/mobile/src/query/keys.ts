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
   * The person's own inbox — and the SECOND clinical key without a branch.
   *
   * This one was branch-scoped when it was speculative (nothing read it before M4), and that was
   * wrong. A notification is addressed to a PERSON, not to a site: `GET /notifications/me` applies
   * no branch filter, so keying it per branch would cache one answer under two names, and a
   * doctor's badge would drop to zero the moment they switched the picker to look at another site.
   * Zero unread is exactly what "nothing needs you" looks like, which is why this is worth a
   * paragraph rather than a line.
   *
   * `filters` still segments it, because the bell asks for the unread five and the inbox screen
   * pages through everything — same endpoint, different requests, so different cache entries.
   * See `AI_Workflow/docs/COMMUNICATION_POLICY.md`.
   */
  notifications: (tenantSlug: string, filters?: string) =>
    [tenantSlug, "notifications", filters ?? ""] as const,

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

  /* ── M2, the doctor's read-only surface ─────────────────────────────────── */

  /** One visit. */
  encounter: (scope: QueryScope, id: string) => scoped(scope, "encounter", id),
  /**
   * Everyone in a bed right now (`GET /inpatients`) — feature-gated on `module.ops.ipd`.
   *
   * Takes a `filters` segment like every other list, because the ward is read two ways: the round
   * itself pages through it, and the home screen asks for one row to read `meta.total` off. Same
   * endpoint, different requests — so they must be different cache entries, or the count query
   * would serve its one-row answer to the list.
   */
  inpatients: (scope: QueryScope, filters?: string) => scoped(scope, "inpatients", filters ?? ""),
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
  /** One prescription, by id. Singular — see the list/record note above. */
  prescription: (scope: QueryScope, id: string) => scoped(scope, "prescription", id),
  /** Prescriptions, filtered server-side; `filters` is the serialised query. */
  prescriptions: (scope: QueryScope, filters?: string) =>
    scoped(scope, "prescriptions", filters ?? ""),
  /**
   * The price-free service catalogue the order and prescribing pads read.
   *
   * Branch-scoped like everything else, even though the catalogue is configuration rather than
   * clinical data: a hospital may genuinely stock different things at different sites, and the
   * server's own scoping decides. Guessing that it is tenant-wide would be a guess, and the cost
   * of being wrong is a doctor offered a test the branch cannot run.
   */
  catalogue: (scope: QueryScope, category?: string) =>
    scoped(scope, "catalogue", category ?? "all"),
  /** Every encounter in one care story (`GET /episodes/:id/timeline`). */
  episodeTimeline: (scope: QueryScope, episodeId: string) =>
    scoped(scope, "episode", episodeId, "timeline"),

  /* ── M2 J, the inpatient surface ────────────────────────────────────────── */

  /**
   * The estate: wards, rooms, beds and who is in them (`GET /bed-board`).
   *
   * Branch-scoped like the ward list it enriches — and it must be, more than most: a bed code is
   * only unique within a site, so `bed 14` at Hyderabad and `bed 14` at Chennai are two different
   * beds with two different patients in them. A key without the branch would put one over the other.
   */
  bedBoard: (scope: QueryScope) => scoped(scope, "bed-board"),
  /** One stay's running record (`GET /encounters/:id/notes`). */
  wardNotes: (scope: QueryScope, encounterId: string) =>
    scoped(scope, "encounter", encounterId, "notes"),
  /**
   * What was actually given (`GET /encounters/:id/medication-administrations`).
   *
   * Gated on `module.clinical.nursing`, which is a DIFFERENT flag from the ward's `module.ops.ipd`
   * — hence its own key and its own query, so a hospital with beds and no nursing module loses the
   * MAR section and keeps the rest of the chart.
   */
  medications: (scope: QueryScope, encounterId: string) =>
    scoped(scope, "encounter", encounterId, "medications"),

  /* ── M3, the nurse's surface ────────────────────────────────────────────── */

  /**
   * The ward worklist (`GET /ward-worklist`) — one page of admitted patients with allergy and
   * due-dose state resolved server-side.
   *
   * Branch-scoped, and takes a `filters` segment like every other list: the SAME ward name means
   * different patients at different sites, and the screen asks for one ward at a time. Without
   * the filter in the key, switching ward would serve the previous ward's rows for a frame — a
   * list of the wrong patients, which is the failure this whole file exists to prevent.
   */
  wardWorklist: (scope: QueryScope, filters?: string) =>
    scoped(scope, "ward-worklist", filters ?? ""),

  /**
   * What is DUE on one stay today (`GET /encounters/:id/medication-schedule`).
   *
   * A SEPARATE key from `medications`, which is the record of what was given. They answer
   * different questions and one must never be served for the other: "the 14:00 dose is due" and
   * "the 14:00 dose was given" differ by exactly the thing a nurse is deciding.
   */
  medicationSchedule: (scope: QueryScope, encounterId: string) =>
    scoped(scope, "encounter", encounterId, "medication-schedule"),

  /**
   * The medication round (`GET /medication-round`) — a ward's doses for one clinical DAY.
   *
   * ── THREE DIMENSIONS, AND EVERY ONE OF THEM HAS BITTEN SOMEBODY ─────────────
   * The branch comes from `scoped`, as everywhere. The other two ride in `filters`:
   *
   *   WARD — "A Ward" at Hyderabad and "A Ward" at Chennai are different patients, and even within
   *          one site a nurse switching ward must not see the previous ward's doses for a frame.
   *   DATE — yesterday's round and today's are the same URL but for one parameter, and they differ
   *          by exactly the thing being decided. Serving one for the other would show a nurse a
   *          list of doses that were given eighteen hours ago as though they were outstanding.
   *
   * A SEPARATE key from `wardWorklist`, which is the same ward answered a different way (counts,
   * no slots, no names). Same word in two keys would collide two response shapes.
   */
  medicationRound: (scope: QueryScope, filters?: string) =>
    scoped(scope, "medication-round", filters ?? ""),
} as const;
