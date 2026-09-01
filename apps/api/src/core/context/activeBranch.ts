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
export async function writeBranchId(requested?: string): Promise<string | undefined> {
  const ctx = getContext();

  // 0. A branch named by the CALLER — a `branchId` in the request body. It must be checked
  //    against the caller's allowed set before it is trusted; see `assertWritableBranch`.
  if (requested !== undefined) return assertWritableBranch(requested);

  // 1. An explicit selection always wins — it was validated ⊆ the allowed set in `authorize`.
  if (ctx.activeBranchId) return ctx.activeBranchId;

  const scope = ctx.scope;

  /**
   * 2. Resolve against the branches that are actually OPEN.
   *
   * There used to be a short-circuit here: a confined caller holding exactly one branch got that
   * branch with no query. It was one query cheaper and wrong in one case — the branch had closed.
   * Holding a binding to a site is not the same as the site being open, and nothing revokes the
   * binding when a hospital retires a branch, so a receptionist whose only branch had shut went on
   * stamping new records into it. `activeBranchCandidates` already intersects the held set with
   * `status: "active"`, so deleting the special case is both the fix and one fewer branch of logic.
   * The cost is identical: the same single indexed lookup either way.
   */
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

/**
 * A branch the CALLER asked to write into, checked against what they may actually reach.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * ADR-0015's guarantee is that "`branchId` is written in exactly one way", so that "which
 * branch created this row?" has one answer and one test surface. Five services quietly
 * broke it by preferring a client value over this function:
 *
 *     const branchId = input.branchId ?? (await writeBranchId());
 *
 * `input.branchId` comes straight from the request body, and nothing checked it. A
 * receptionist confined to Hyderabad could therefore `POST /patients` with Chennai's id in
 * the payload and the row was created **in Chennai** — a branch she cannot read, write or
 * even see in her switcher. The header route was validated (`resolveActiveBranch`), the
 * query string is refused by a `.strict()` schema, and the body was wide open. Proven by
 * the branch-isolation suite, which failed on exactly this before this function existed.
 *
 * ── REFUSE, WHERE THE HEADER ONLY IGNORES ───────────────────────────────────
 * `resolveActiveBranch` treats an unreachable branch in `X-Active-Branch` as "not
 * selected" and falls back to the caller's own scope, because a header is UI state that
 * goes stale legitimately — a branch removed from your set while the tab is open. A
 * `branchId` in a mutation body is not stale UI state; it is an explicit instruction to
 * write somewhere. Silently redirecting it would make the API lie about what it did, so
 * this refuses with HMS-AUTH-005: authenticated, holds the permission, not for that site.
 *
 * ── WHY "NO SCOPE" MEANS TRUST ──────────────────────────────────────────────
 * `ctx.scope` is published by `authorize`, so it exists on every authorized HTTP request
 * and is absent for internal callers — seeds, migrations, queue consumers — which supply a
 * branch from trusted code and have no user to constrain. `scopeFilter` already reads an
 * absent scope the same way (`if (!scope) return {}`).
 */
function assertWritableBranch(requested: string): string {
  const scope = getContext().scope;
  if (!scope) return requested;
  if (scope.allBranches || scope.branchIds.includes(requested)) return requested;

  throw new AppError("HMS-AUTH-005", 403, "Insufficient permission", {
    branchId: ["you may not create records in that branch"],
  });
}

/**
 * Is this id a branch this hospital is still operating?
 *
 * ── MEMBERSHIP IS NOT THE SAME QUESTION AS "IS IT OPEN" ─────────────────────
 * `authorize` used to accept `X-Active-Branch` on membership alone, and for a hospital-wide
 * binding on nothing at all — `allBranches` short-circuited before the id was looked at. Two
 * consequences, and the second is the worse one:
 *
 *   1. A RETIRED branch stayed usable. `/me/branches` stops listing it, so the switcher forgets
 *      it, but a phone that remembered the selection — or any client repeating a stored header —
 *      kept acting in a site the hospital has closed. Membership outlives the branch: a user's
 *      binding is not revoked when the site shuts.
 *   2. A hospital-wide caller could name ANY id, including a branch belonging to ANOTHER TENANT.
 *      Reads stayed safe (`tenantScopePlugin` still filters by tenant, so the query matched
 *      nothing), but `writeBranchId` stamps `ctx.activeBranchId` onto new rows — so the id of a
 *      different hospital's branch could be written into this one's records.
 *
 * Both close with the same check, so it applies to confined and hospital-wide callers alike.
 * `tenantId` is in the filter, not assumed from the id.
 *
 * One `_id` lookup, and only when the header is present — an absent header is the ordinary case
 * and still touches no database.
 */
export async function isActiveBranch(branchId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(branchId)) return false;
  const ctx = getContext();
  const row = await ctx.connection
    .collection<BranchRow>("branches")
    .findOne(
      { _id: new Types.ObjectId(branchId), tenantId: ctx.tenantId, status: "active" },
      { projection: { _id: 1 } },
    );
  return row !== null;
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
