/**
 * React bindings for the vanilla stores.
 *
 * The stores themselves are `zustand/vanilla` so the session and branch logic can be tested in
 * Node. `useStore` is the adapter that makes them reactive here — the only place React and the
 * state layer meet.
 */
import { useStore } from "zustand";
import { useRuntime } from "../providers/RuntimeProvider.js";
import { can, type SessionState } from "../state/session.js";
import { activeBranchLabel, type BranchState } from "../state/branch.js";
import type { ConnectivityState } from "../state/connectivity.js";

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(useRuntime().session, selector);
}

export function useBranch<T>(selector: (state: BranchState) => T): T {
  return useStore(useRuntime().branch, selector);
}

export function useConnectivity<T>(selector: (state: ConnectivityState) => T): T {
  return useStore(useRuntime().connectivity, selector);
}

/** The permission set, and the one question a screen may ask of it. */
export function useCapabilities(): { can: (permission: string) => boolean; ready: boolean } {
  const permissions = useSession((s) => s.permissions);
  const status = useSession((s) => s.status);
  return {
    can: (permission: string) => can({ permissions } as SessionState, permission),
    ready: status === "signedIn",
  };
}

export function useActiveBranchLabel(): string {
  return useBranch(activeBranchLabel);
}

/** True only when a single site is resolved — the condition a clinical write needs. */
export function useBranchResolved(): boolean {
  return useBranch((s) => s.validated && s.activeBranchId !== undefined);
}
