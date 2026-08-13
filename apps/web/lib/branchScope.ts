/**
 * WHOSE DATA IS ON SCREEN — the identity that branch-scoped view state belongs to (ADR-0015).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * Selecting a branch used to call `router.refresh()`. In the App Router that re-fetches Server
 * Components and — documented behaviour — **preserves client React state**. Every data page in
 * this app is `"use client"` and loads in a `useEffect` whose dependencies are the API client
 * (memoised once, forever) and the page's own filters. None of them mention the branch, because
 * the branch travels in a header the client reads per request rather than in a prop.
 *
 * So nothing re-ran. The header said Chennai and the list underneath it was still Hyderabad's:
 * the one screen state that must never outlive a branch change is the only one that did.
 *
 * ── WHY IDENTITY, RATHER THAN A DEPENDENCY ON EVERY PAGE ────────────────────
 * The alternative fix is to thread the active branch into all 44 pages' effect dependencies. That
 * works on the day it is written and decays immediately: the 45th page is written by someone who
 * has never heard of this file, and it is wrong in a way nothing detects. Identity is the same
 * decision made once — the routed subtree is *keyed* on the scope, so a scope change discards it
 * and every loader in it starts again, whether or not its author knew any of this.
 *
 * It is the web analogue of what mobile does with `onBranchChanged: () => queryClient.clear()`.
 * Mobile's cross-page state lives in a query cache, so clearing the cache is the whole job. Web
 * has no cache — its cross-page state lives in React components — so discarding the components is.
 *
 * ── NOTHING HERE IS A SECURITY BOUNDARY ─────────────────────────────────────
 * The server scopes every read from the `X-Active-Branch` header it validates against the caller's
 * own bindings. This module cannot widen what a user may see and is not trying to; it stops one
 * branch's data being DISPLAYED under another's name. Presentation, not authorization.
 */

/** The scope when no single branch is selected — the aggregate ("All branches") view. */
export const ALL_BRANCHES = "all";

export interface ScopeInput {
  /**
   * The hostname being browsed, which IS the hospital (ADR-0005).
   *
   * Included as a second lock, not as the wall. The wall is the browser's own origin: a different
   * tenant is a different hostname, so it gets a different document, a different `sessionStorage`
   * and a fresh React tree — there is no path by which tenant A's components survive into tenant
   * B. Folding the host into the identity costs nothing and means the identity is honest about
   * what it names, in the same spirit as `tenantScopePlugin` stamping a tenantId the
   * database-per-tenant connection already guarantees.
   */
  tenant: string;
  /** The active branch, or `null` in aggregate mode. */
  branchId: string | null;
}

/**
 * The identity of the data a branch-scoped screen is showing.
 *
 * Stable for the same tenant and branch (so nothing remounts while a user works), and different
 * the moment either changes (so everything does).
 */
export function branchScopeId(input: ScopeInput): string {
  return `${input.tenant}::${input.branchId ?? ALL_BRANCHES}`;
}

/**
 * Does moving from one scope to another mean the view state must be thrown away?
 *
 * `from` is `undefined` on the very first render — there is no previous scope, so there is nothing
 * to discard and no reason to make the first paint of the application flicker.
 */
export function discardsViewState(from: string | undefined, to: string): boolean {
  return from !== undefined && from !== to;
}

export interface ReconcileInput {
  /** What this tab last chose, from `sessionStorage`. */
  stored: string | null;
  /** The branches the signed-in user may act in, as the server just reported them. */
  branches: readonly { id: string }[];
  /** Whether this user may choose the aggregate view at all. */
  canAggregate: boolean;
}

export interface ReconcileResult {
  /** The branch to work in, or `null` for aggregate / none chosen. */
  branchId: string | null;
  /** True when the stored value must be overwritten — it was absent, stale or unreachable. */
  persist: boolean;
}

/**
 * Which branch this tab should actually be working in, given what it remembers and what the user
 * may now reach.
 *
 * ── A REMEMBERED BRANCH IS A CLAIM, NOT A FACT ──────────────────────────────
 * `sessionStorage` outlives a change of access: a nurse moved from Hyderabad to Chennai, or a
 * binding revoked while the tab sat open, leaves a branch id behind that the user can no longer
 * act in. The server would reject it — `authorize` validates the header against the live binding —
 * so this is not a security hole. It is a usability one, and a nasty shape of it: every request
 * fails with nothing on screen explaining why, because the switcher is still displaying a site
 * the user has lost. So an unreachable value is dropped rather than sent.
 *
 * The single-branch case is separate and is why this returns `persist`: a user with exactly one
 * branch and no aggregate right has no choice to make, so we pin them to it rather than leaving
 * them in an aggregate mode they may not use — and we write it down, so the next tab agrees.
 */
export function reconcileBranch(input: ReconcileInput): ReconcileResult {
  const reachable =
    input.stored !== null && input.branches.some((b) => b.id === input.stored)
      ? input.stored
      : null;

  // No real choice: one site, no aggregate right. Pin it, and record it.
  if (reachable === null && input.branches.length === 1 && !input.canAggregate) {
    const only = input.branches[0]?.id ?? null;
    return { branchId: only, persist: true };
  }

  // Otherwise the reachable value stands. Persist only when what we hold differs from what we
  // remembered — writing an unchanged value back would be a pointless storage write per login.
  return { branchId: reachable, persist: reachable !== input.stored };
}
