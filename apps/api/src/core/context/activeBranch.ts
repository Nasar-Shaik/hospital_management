/**
 * Which branch does a WRITE belong to? (ADR-0015)
 *
 * Reads are narrowed by `scopeFilter`; writes are STAMPED here. There is one resolution rule, in one
 * place, so "which branch created this row?" has a single answer and a single test surface — the
 * same discipline `tenantScopePlugin` applies to `tenantId`.
 *
 * The rule:
 *   1. An active branch was selected  → stamp it.
 *   2. No active branch, but the caller can reach exactly ONE branch → stamp that (a single-site
 *      hospital, or a single-branch user, never has to choose; this is what keeps the whole feature
 *      invisible to them).
 *   3. No active branch and the caller can reach several → refuse with HMS-BRANCH-001. A record with
 *      the wrong branch is worse than a paused action: the user must pick a site to create in.
 *
 * Raw collection access (`connection.collection("branches")`) on purpose: this lives in `core`, which
 * does not import feature modules, and it mirrors how `core` already reads `counters` and `outbox` by
 * name. It only queries in the fallback (no active branch), so the hot path — a client that sends
 * `X-Active-Branch` — never touches the database here.
 */
import { Types } from "mongoose";
import { AppError } from "../errors/appError.js";
import { getContext } from "./requestContext.js";

interface BranchRow {
  _id: Types.ObjectId;
}

/**
 * The branch id to stamp on a new operational record (ADR-0015), or `undefined` when the write is
 * legitimately branchless.
 *
 * It REFUSES (HMS-BRANCH-001) in exactly one situation: the caller can reach several branches and has
 * selected none, so stamping any of them would be a guess. Every other case resolves cleanly:
 *   - a branch is selected                        → that branch;
 *   - the caller can reach exactly one branch     → that branch (single-site: no choice to make);
 *   - the hospital has NO branches yet            → `undefined`, i.e. today's behaviour.
 *
 * The last case is what keeps the rollout safe: between deploying this code and running the
 * `migrate --all` that seeds each tenant's Main Branch, an operational write must NOT start failing —
 * it simply writes no branch, exactly as it did before branches existed. Once the Main Branch is
 * seeded there is one candidate and every write is stamped.
 */
export async function writeBranchId(): Promise<string | undefined> {
  const ctx = getContext();

  // 1. An explicit selection always wins — it was validated ⊆ the allowed set in `authorize`.
  if (ctx.activeBranchId) return ctx.activeBranchId;

  const scope = ctx.scope;

  // 2. A confined caller who can reach exactly one branch: no ambiguity, no prompt.
  if (scope && !scope.allBranches && scope.branchIds.length === 1) return scope.branchIds[0];

  // 3. Otherwise resolve the tenant's active branches. A hospital-wide binding sees every active
  //    branch; a confined one sees the branches it holds.
  const candidates = await activeBranchCandidates(
    scope?.allBranches ?? false,
    scope?.branchIds ?? [],
  );

  if (candidates.length === 1) return candidates[0];
  // No branches configured (pre-migration, or a brand-new empty tenant) → branchless, as before.
  if (candidates.length === 0) return undefined;

  // Several branches and none chosen — the one case we must not guess.
  throw new AppError("HMS-BRANCH-001", 400, "No active branch selected", {
    hint: "pick a branch in the switcher before creating records",
  });
}

/** The active branches the caller could write to — one query, only on the no-selection fallback. */
async function activeBranchCandidates(
  allBranches: boolean,
  branchIds: string[],
): Promise<string[]> {
  const ctx = getContext();
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId, status: "active" };
  if (!allBranches) {
    // Only the branches the caller already holds, intersected with "still active".
    const objectIds = branchIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];
    filter._id = { $in: objectIds };
  }

  const rows = await ctx.connection
    .collection<BranchRow>("branches")
    .find(filter, { projection: { _id: 1 } })
    .toArray();
  return rows.map((r) => r._id.toString());
}
