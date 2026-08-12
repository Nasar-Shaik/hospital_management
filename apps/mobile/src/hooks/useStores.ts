/**
 * React bindings for the vanilla stores.
 *
 * The stores themselves are `zustand/vanilla` so the session and branch logic can be tested in
 * Node. `useStore` is the adapter that makes them reactive here — the only place React and the
 * state layer meet.
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import { useRuntime } from "../providers/RuntimeProvider";
import { can, type SessionState } from "../state/session";
import { activeBranchLabel, type BranchState } from "../state/branch";
import type { ConnectivityState } from "../state/connectivity";

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(useRuntime().session, selector);
}

export function useBranch<T>(selector: (state: BranchState) => T): T {
  return useStore(useRuntime().branch, selector);
}

export function useConnectivity<T>(selector: (state: ConnectivityState) => T): T {
  return useStore(useRuntime().connectivity, selector);
}

/**
 * The permission set, and the one question a screen may ask of it.
 *
 * Memoised because it returns an OBJECT. Nothing today puts it in a dependency array — every caller
 * destructures a primitive off it — but an un-memoised object is a new value on every render, and
 * the first `useEffect(..., [capabilities])` would loop. The two selectors above it are safe (a
 * `Set` from the store and a string), so the memo has real inputs to key on.
 */
export function useCapabilities(): { can: (permission: string) => boolean; ready: boolean } {
  const permissions = useSession((s) => s.permissions);
  const status = useSession((s) => s.status);
  return useMemo(
    () => ({
      can: (permission: string) => can({ permissions } as SessionState, permission),
      ready: status === "signedIn",
    }),
    [permissions, status],
  );
}

export function useActiveBranchLabel(): string {
  return useBranch(activeBranchLabel);
}

/** True only when a single site is resolved — the condition a clinical write needs. */
export function useBranchResolved(): boolean {
  return useBranch((s) => s.validated && s.activeBranchId !== undefined);
}
