"use client";

/**
 * The active-branch context for the web app (ADR-0015).
 *
 * Loads the branches the signed-in user may act in (`GET /me/branches`), remembers which one is
 * active (per tab — see `lib/activeBranch.ts`), and refreshes the app when it changes so every list
 * re-fetches through the new `X-Active-Branch` header.
 *
 * It is deliberately thin: the API client already reads the active branch live on each request, so
 * this provider's only jobs are (1) give the switcher its data and (2) turn a selection into a
 * refetch. A single-branch hospital or a single-branch user has nothing to choose — the switcher
 * simply shows their one site.
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
import { useRouter } from "next/navigation";
import type { Branch } from "@medicore/api-client";
import { useAuth } from "./AuthProvider";
import { getActiveBranchId, setActiveBranchId } from "../lib/activeBranch";

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
  /** Select a branch by id, or `null` for All. Persists and refreshes the app. */
  select: (branchId: string | null) => void;
}

const BranchContext = createContext<BranchContextValue | null>(null);

export function BranchProvider({ children }: { children: ReactNode }) {
  const { user, api } = useAuth();
  const router = useRouter();

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

        // Reconcile the stored selection with what the user may actually reach now. If their stored
        // branch is gone (access changed), fall back: to their only branch, or to All.
        const stored = getActiveBranchId() ?? null;
        const valid = stored && res.branches.some((b) => b.id === stored) ? stored : null;
        if (!valid && res.branches.length === 1 && !res.canAggregate) {
          // A single-branch user always works in that one site — pin it, no choice to make.
          apply(res.branches[0]?.id ?? null);
        } else if (valid !== stored) {
          apply(valid);
        } else {
          setActiveId(valid);
        }
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

  const select = useCallback(
    (branchId: string | null) => {
      apply(branchId);
      // Everything on screen was fetched for the old branch — pull it all again.
      router.refresh();
    },
    [apply, router],
  );

  const value = useMemo<BranchContextValue>(() => {
    const active = branches.find((b) => b.id === activeId) ?? null;
    return {
      branches,
      active,
      canAggregate,
      loading,
      hasChoice: branches.length > 1 || canAggregate,
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
