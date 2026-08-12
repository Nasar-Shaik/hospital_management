/**
 * The bridge between the runtime and a clinical screen: scope, queries, and the display zone.
 *
 * ── A SCREEN NEVER ASSEMBLES A SCOPE ITSELF ─────────────────────────────────
 * There is one definition of "which branch am I reading", it lives here, and it matches what the
 * api-client will actually put on the wire. If the two ever disagreed, the cache would be keyed to
 * one branch while the request asked for another — the exact failure the key prefix exists to stop.
 */
import { useMemo } from "react";
import { useRuntime } from "../providers/RuntimeProvider";
import { useBranch, useSession } from "./useStores";
import { clinicalQueries, type ClinicalQueries } from "../query/clinical";
import { scopeFor } from "../query/scope";
import type { QueryScope } from "../query/keys";
import { zoneResolver, type ZoneResolver } from "../clinical/zone";

export interface ClinicalContext {
  queries: ClinicalQueries;
  scope: QueryScope;
  /**
   * False until `/me/branches` has been read in this app session. Branch-sensitive queries are
   * gated on it — see below.
   */
  ready: boolean;
  /** The signed-in user's id, which is what `?doctorId=` takes. `undefined` while bootstrapping. */
  userId?: string;
}

export function useClinical(): ClinicalContext {
  const runtime = useRuntime();
  const validated = useBranch((s) => s.validated);
  const activeBranchId = useBranch((s) => s.activeBranchId);
  const userId = useSession((s) => s.user?.id);

  /**
   * The derivation lives in `scopeFor` rather than inline, so the branch-key tests can drive the
   * SAME code the app does instead of re-implementing it — see the note in `query/scope.ts`.
   *
   * `ready` exists so screens can simply not ask until the branch is settled, which is better than
   * showing an aggregate list for one frame and then replacing it.
   */
  const scope = useMemo<QueryScope>(
    () =>
      scopeFor(runtime.profile.slug, { validated, ...(activeBranchId ? { activeBranchId } : {}) }),
    [runtime.profile.slug, validated, activeBranchId],
  );

  const queries = useMemo(() => clinicalQueries(runtime.api, scope), [runtime.api, scope]);

  return {
    queries,
    scope,
    ready: validated,
    ...(userId ? { userId } : {}),
  };
}

/**
 * How to stamp a clinical instant, for every record this screen will render.
 *
 * Returns a FUNCTION rather than a zone string because one list legitimately spans sites in
 * All-branches mode, and a single zone for the screen would misdate half of it. See `clinical/zone`
 * for why a record's own `branchId` is safe to use as a lookup key and unsafe as anything else.
 */
export function useZoneFor(): ZoneResolver {
  const branches = useBranch((s) => s.branches);
  const activeBranchId = useBranch((s) => s.activeBranchId);
  return useMemo(() => zoneResolver(branches, activeBranchId), [branches, activeBranchId]);
}
