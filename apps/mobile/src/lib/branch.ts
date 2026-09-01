/**
 * Branch restoration and switching (ADR-0015, M0 §7).
 *
 * ── `/me/branches` OUTRANKS ANYTHING THE PHONE REMEMBERS ────────────────────
 * The persisted branch is a CACHE OF A SERVER FACT, not a preference. It is re-validated against a
 * fresh list at every point where it could have gone stale — cold start, resume, after login, and
 * after any branch-shaped refusal — and it is never sent before that list has been read in this
 * app session (`BranchState.validated`).
 *
 * This is load-bearing rather than tidy. The server validates `X-Active-Branch` against the
 * caller's MEMBERSHIP; for a hospital-wide user that check passes for any branch id, including one
 * that has since been set inactive. `/me/branches` filters those out and the header path does not
 * (backend item F). So for an administrator or a roaming consultant, this function is the only
 * thing standing between a remembered selection and records created against a closed site.
 */
import type { ApiClient, Branch } from "@medicore/api-client";
import type { BranchStore } from "../state/branch";
import type { Preferences } from "./storage";
import { storageKeys } from "./storage";

/** The sentinel persisted for All-branches mode, matching what the API calls it. */
const AGGREGATE = "all";

export type RestoreOutcome =
  /** The remembered branch is still valid and is now active. */
  | { outcome: "restored"; branchId: string }
  /** Aggregate mode was remembered and is still offered. */
  | { outcome: "restoredAggregate" }
  /** Only one site is reachable, so there was no choice to make. */
  | { outcome: "auto"; branchId: string }
  /** Several sites and no valid memory — the user must pick before any write. */
  | { outcome: "prompt" }
  /** The hospital has no branches configured. Writes are branchless, exactly as before ADR-0015. */
  | { outcome: "none" };

export interface BranchController {
  /** Reads `/me/branches` and updates the store. Every other method goes through this first. */
  load(): Promise<{ branches: Branch[]; canAggregate: boolean }>;
  /** Load, then decide what the active branch should be. Safe to call repeatedly. */
  restore(userId: string): Promise<RestoreOutcome>;
  /** The user picked one. `undefined` means All-branches. */
  select(userId: string, branchId: string | undefined): Promise<void>;
  /** Forget the remembered choice for this user — used when the server says it is no longer valid. */
  forget(userId: string): Promise<void>;
}

export interface BranchControllerDeps {
  api: ApiClient;
  store: BranchStore;
  preferences: Preferences;
  slug: string;
  /**
   * Called whenever the active branch CHANGES, before the new context loads. Wired to
   * `queryClient.clear()`: the same query key against a different branch is different data, and
   * showing the previous site's list for one frame is a clinical error, not a rendering one.
   */
  onBranchChanged: () => void;
}

export function createBranchController(deps: BranchControllerDeps): BranchController {
  const { api, store, preferences, slug } = deps;
  const keyFor = (userId: string): string => storageKeys.activeBranch(slug, userId);

  async function load(): Promise<{ branches: Branch[]; canAggregate: boolean }> {
    const mine = await api.listMyBranches();
    store.getState().setBranches(mine.branches, mine.canAggregate);
    return mine;
  }

  return {
    load,

    async restore(userId) {
      const { branches, canAggregate } = await load();
      const remembered = await preferences.get(keyFor(userId));

      if (branches.length === 0) {
        store.getState().select(undefined);
        return { outcome: "none" };
      }

      if (remembered === AGGREGATE) {
        // Aggregate is only restorable if the server still offers it — a user moved down to one
        // branch loses the option, and must not keep sending a mode they no longer have.
        if (canAggregate) {
          store.getState().select(undefined);
          return { outcome: "restoredAggregate" };
        }
        await preferences.remove(keyFor(userId));
      } else if (remembered) {
        const stillAMember = branches.some((branch) => branch.id === remembered);
        if (stillAMember) {
          store.getState().select(remembered);
          return { outcome: "restored", branchId: remembered };
        }
        /**
         * Membership changed, or the site was retired. Drop it rather than leaving it to be
         * "helpfully" retried later — a stale id that survives one failed validation will be sent
         * eventually, which is the whole failure this function exists to prevent.
         */
        await preferences.remove(keyFor(userId));
      }

      const only = branches.length === 1 ? branches[0] : undefined;
      if (only) {
        await preferences.set(keyFor(userId), only.id);
        store.getState().select(only.id);
        return { outcome: "auto", branchId: only.id };
      }

      // Several sites, nothing valid remembered. Leave the selection EMPTY: reads aggregate (or
      // are refused), and the first write is refused with HMS-BRANCH-001 rather than guessing.
      store.getState().select(undefined);
      return { outcome: "prompt" };
    },

    async select(userId, branchId) {
      const previous = store.getState().activeBranchId;
      if (previous === branchId) return;

      if (branchId === undefined) {
        // Only offer-able when the server said so; guard anyway, because a stale UI could ask.
        if (!store.getState().canAggregate) return;
        await preferences.set(keyFor(userId), AGGREGATE);
      } else {
        const reachable = store.getState().branches.some((branch) => branch.id === branchId);
        // Not an authorization check — the server does that. This stops the UI from persisting a
        // choice that came from a list it has since replaced.
        if (!reachable) return;
        await preferences.set(keyFor(userId), branchId);
      }

      store.getState().select(branchId);
      deps.onBranchChanged();
    },

    async forget(userId) {
      await preferences.remove(keyFor(userId));
      store.getState().select(undefined);
    },
  };
}
