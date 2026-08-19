"use client";

/**
 * The active-branch context for the web app (ADR-0015).
 *
 * Loads the branches the signed-in user may act in (`GET /me/branches`), remembers which one is
 * active (per tab — see `lib/activeBranch.ts`), and publishes the SCOPE IDENTITY that the routed
 * subtree is keyed on, so a selection discards the previous branch's data (see `BranchScope`).
 *
 * It is deliberately thin: the API client already reads the active branch live on each request, so
 * this provider's only jobs are (1) give the switcher its data and (2) turn a selection into a new
 * scope. A single-branch hospital or a single-branch user has nothing to choose — the switcher
 * simply shows their one site.
 *
 * ── IT NO LONGER CALLS `router.refresh()` ───────────────────────────────────
 * It used to, and that was the bug. `router.refresh()` re-fetches Server Components and preserves
 * client React state — and every data page here is a client component holding its rows in
 * `useState`. So the header changed and the data did not. The scope key below is what actually
 * reloads the screen, and it does it by discarding the components rather than by asking them
 * nicely. Removing the refresh also removes a redundant RSC round trip per switch.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Branch } from "@medicore/api-client";
import { useAuth } from "./AuthProvider";
import { getActiveBranchId, setActiveBranchId } from "../lib/activeBranch";
import { branchScopeId, mustChooseBranchToWrite, reconcileBranch } from "../lib/branchScope";
import { resolveZone } from "../lib/day";
import { currentHost } from "../lib/api";

interface BranchContextValue {
  /** The branches this user may act in. Empty until loaded, or for a user bound to none. */
  branches: Branch[];
  /** The active branch, or null in "All branches" (aggregate) mode. */
  active: Branch | null;
  /** True when the user may choose "All branches". */
  canAggregate: boolean;
  /** True while the branch list is loading. */
  loading: boolean;
  /** Whether the switcher is worth showing at all (more than one option). */
  hasChoice: boolean;
  /**
   * True when a write that STAMPS A BRANCH cannot succeed until a site is chosen (D19).
   *
   * The same predicate the server applies in `writeBranchId()` — several reachable sites and none
   * selected — so the UI stops asking for work the API is already going to refuse. Not a security
   * boundary: see `mustChooseBranchToWrite`.
   */
  mustChooseBranch: boolean;
  /**
   * Identity of the data a branch-scoped screen is showing. The routed subtree is keyed on it, so
   * a change here discards that screen and everything reloads for the new branch.
   */
  scopeId: string;
  /**
   * The timezone a clinical or operational DAY is reckoned in — the active branch's, else the
   * hospital's main site, else the platform default. Never the browser's.
   *
   * Resolved once, here, so no screen decides for itself: "today" on the theatre board and "today"
   * on the ward have to be the same day, and a page that reached for `Intl` locally would make
   * them the reader's day instead of the ward's. In All-branches mode there is no active site to
   * borrow from, so the main branch stands in — a report spanning sites still needs ONE calendar.
   */
  timezone: string;
  /** Select a branch by id, or `null` for All. Persists, and re-scopes the app. */
  select: (branchId: string | null) => void;
}

const BranchContext = createContext<BranchContextValue | null>(null);

export function BranchProvider({ children }: { children: ReactNode }) {
  const { user, api } = useAuth();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [canAggregate, setCanAggregate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveBranchId() ?? null);

  const apply = useCallback((branchId: string | null) => {
    setActiveBranchId(branchId ?? undefined);
    setActiveId(branchId);
  }, []);

  // Load the user's branches once they are signed in. A failure (e.g. a role with no branch) leaves
  // an empty list, which the switcher renders as "no branch" rather than blowing up the shell.
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setBranches([]);
      setCanAggregate(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .listMyBranches()
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
        setCanAggregate(res.canAggregate);

        // Reconcile the stored selection with what the user may actually reach now — the decision
        // lives in `lib/branchScope.ts` so its edge cases (revoked binding, single-site user,
        // aggregate right) can be tested without standing up a session.
        const decided = reconcileBranch({
          stored: getActiveBranchId() ?? null,
          branches: res.branches,
          canAggregate: res.canAggregate,
        });
        if (decided.persist) apply(decided.branchId);
        else setActiveId(decided.branchId);
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
          setCanAggregate(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, api, apply]);

  /**
   * Everything on screen was fetched for the old branch. Changing `activeId` changes `scopeId`,
   * which re-keys the routed subtree — React discards those components and their state, and their
   * loaders run again against the new `X-Active-Branch` header. No `router.refresh()`: it re-fetches
   * Server Components and preserves exactly the client state that had to go.
   */
  const select = useCallback((branchId: string | null) => apply(branchId), [apply]);

  const value = useMemo<BranchContextValue>(() => {
    const active = branches.find((b) => b.id === activeId) ?? null;
    return {
      branches,
      active,
      canAggregate,
      loading,
      hasChoice: branches.length > 1 || canAggregate,
      mustChooseBranch: mustChooseBranchToWrite({ branches, active }),
      scopeId: branchScopeId({ tenant: currentHost(), branchId: activeId }),
      timezone: resolveZone(
        active?.timezone,
        branches.find((b) => b.isMain)?.timezone,
        branches[0]?.timezone,
      ),
      select,
    };
  }, [branches, activeId, canAggregate, loading, select]);

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error("useBranch must be used inside <BranchProvider>");
  return ctx;
}
