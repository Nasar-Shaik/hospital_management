/**
 * "Which branch am I reading?" — one answer, shared by the cache key and the wire.
 *
 * ── IT IS A FUNCTION, NOT A HOOK, SO A TEST CAN ASK IT THE SAME QUESTION ────
 * `useClinical` is the only production caller, but a rule that can only be exercised through React
 * is a rule this suite cannot exercise at all — it runs in Node with no renderer. Pulling the
 * derivation out means the branch-key tests drive the SAME code the app does, rather than a
 * re-implementation in the test that would keep passing after the app's copy changed.
 *
 * ── AND IT MUST MIRROR `getActiveBranch` EXACTLY ────────────────────────────
 * `createRuntime` hands the api-client `() => validated ? activeBranchId : undefined`. If this
 * disagreed, the cache would be keyed to one branch while the request asked for another — a list
 * filed under the wrong site's name, which is the precise failure the key prefix exists to prevent.
 * The two are asserted equal in the M2 suite.
 */
import type { QueryScope } from "./keys";

export interface BranchSelection {
  /** True once `/me/branches` has been read in this app session (M0 §7). */
  validated: boolean;
  /** `undefined` means All-branches, which is legal for reads. */
  activeBranchId?: string;
}

export function scopeFor(tenantSlug: string, branch: BranchSelection): QueryScope {
  return {
    tenantSlug,
    // Before validation there is genuinely no header and the server genuinely aggregates, so the
    // key has to say so. Writing the remembered branch in here would file an aggregate answer
    // under a branch's name and then serve it once the switcher resolves.
    ...(branch.validated && branch.activeBranchId ? { branchId: branch.activeBranchId } : {}),
  };
}
