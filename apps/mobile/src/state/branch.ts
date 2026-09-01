/**
 * Active-branch state (ADR-0015, M0 §7).
 *
 * ── THIS STORE HOLDS A CHOICE, NOT AN AUTHORIZATION ─────────────────────────
 * `activeBranchId` is read live by the api-client and sent as `X-Active-Branch` on every request.
 * The server validates it against the caller's membership on every request too — so what is stored
 * here can only ever narrow what the user may see, never widen it. The app therefore performs no
 * branch authorization of its own, and must not start: a second check here would be a second,
 * drifting copy of a rule the backend owns.
 *
 * The list of branches is SERVER state and belongs in the query cache, not here. What lives here
 * is the one field that must be readable synchronously from a callback, plus the aggregate flag
 * that decides whether an "All branches" option is even offered.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Branch } from "@medicore/api-client";

export interface BranchState {
  /** `undefined` means All-branches (aggregate) mode, which is legal for reads only. */
  activeBranchId?: string;
  /** Whether the server offered aggregate mode. Never inferred from `branches.length`. */
  canAggregate: boolean;
  /** The last list the server gave us — kept for the switcher's labels, refreshed on every load. */
  branches: Branch[];
  /** True once `/me/branches` has been read in this app session. Nothing may be sent before it. */
  validated: boolean;

  setBranches(branches: Branch[], canAggregate: boolean): void;
  select(branchId: string | undefined): void;
  reset(): void;
}

export type BranchStore = StoreApi<BranchState>;

export function createBranchStore(): BranchStore {
  return createStore<BranchState>((set) => ({
    canAggregate: false,
    branches: [],
    validated: false,

    setBranches: (branches, canAggregate) => set({ branches, canAggregate, validated: true }),
    select: (activeBranchId) => set({ activeBranchId }),
    reset: () =>
      set({ activeBranchId: undefined, canAggregate: false, branches: [], validated: false }),
  }));
}

/** The label a switcher shows for the current selection. */
export function activeBranchLabel(state: BranchState): string {
  if (!state.activeBranchId) return state.canAggregate ? "All branches" : "No branch selected";
  return state.branches.find((b) => b.id === state.activeBranchId)?.name ?? "Unknown branch";
}
