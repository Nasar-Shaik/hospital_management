/**
 * Branch service — creating, listing and editing a tenant's sites (ADR-0015).
 *
 * The number of branches a tenant may create is a PLATFORM control (`limits.maxBranches` on the
 * master record), read here through the tenants module's public interface — never by reaching into
 * the master DB, which a business module may not do (Constitution §5). The cap is enforced at the
 * one creation point, exactly like every other edition limit (HMS-PLAN-001).
 */
import { AppError } from "../../core/errors/appError.js";
import { env } from "../../config/env.js";
import { zoneOrDefault } from "../../core/time/zone.js";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { branchlessRows } from "../../seed/mainBranch.js";
import { branchLimit } from "../tenants/index.js";
import { getEffectiveBranchScope } from "../rbac/index.js";
import * as repo from "./branch.repository.js";

export type { Branch } from "./branch.repository.js";

/** How many sites exist right now — the meter on the Subscription screen counts these. */
export const countBranches = repo.count;

export const listBranches = repo.list;
export const getBranch = repo.findById;

/**
 * The branches the CURRENT user may act in, and whether they may aggregate across all of them.
 *
 * This is the switcher's data source and it is self-service — every signed-in person may see the
 * sites they work at, the same way they may see their own sessions. `all` (a hospital-wide binding)
 * returns every active branch plus `canAggregate: true`; a confined binding returns just their
 * branches. A confined user with a single branch gets no real choice, which is correct: they always
 * work in that one site and the switcher simply shows it.
 */
export async function listMyBranches(): Promise<{
  branches: repo.Branch[];
  canAggregate: boolean;
}> {
  const ctx = getContext();
  const userId = ctx.userId;
  if (!userId) return { branches: [], canAggregate: false };

  const { branchIds, allBranches } = await getEffectiveBranchScope(userId);

  if (allBranches) {
    const all = (await repo.list()).filter((b) => b.status === "active");
    // Aggregation is only a real choice when there is more than one site to aggregate.
    return { branches: all, canAggregate: all.length > 1 };
  }

  const mine = (await repo.listByIds(branchIds)).filter((b) => b.status === "active");
  return { branches: mine, canAggregate: mine.length > 1 };
}

export interface CreateBranchInput {
  name: string;
  code: string;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

export async function createBranch(input: CreateBranchInput): Promise<repo.Branch> {
  const ctx = getContext();

  // ── the cap: a platform limit, read from master, enforced here ──────────────
  // Through `branchLimit` so the Subscription screen's branch meter cannot show a different
  // number from the one this line refuses on.
  const maxBranches = await branchLimit(ctx.tenantId);
  const current = await repo.count();
  if (current >= maxBranches) {
    throw new AppError("HMS-PLAN-001", 402, "Plan limit reached", {
      metric: "branches",
      current,
      max: maxBranches,
      hint: "your edition allows this many branches — contact your account manager to raise it",
    });
  }

  /**
   * ── THE SECOND SITE IS THE POINT OF NO RETURN (D11/D12) ─────────────────────
   * `seedMainBranch` adopts pre-branch rows into the Main Branch on the reasoning "there was only
   * one site, so it happened there". That reasoning dies the moment a hospital has two branches,
   * so the backfill DECLINES from then on — and reports what it left behind.
   *
   * Nothing stopped a tenant reaching that state. Three collections carry an OPTIONAL `branchId`
   * and filter reads on it (`reportFiles`, `medicationAdministrations`, `wardNotes`), so a row the
   * backfill never reached becomes invisible to anyone with a branch selected. On the MAR that is
   * a dose that was given reading as never given, and the next nurse gives it again.
   *
   * ── WHY REFUSE HERE RATHER THAN FIX THE READS ───────────────────────────────
   * The alternative was D1's shape: resolve the parent encounter and drop the branch filter. It is
   * correct, and it changes a foreign visit's answer from `200 []` to `404` on three read
   * contracts — one of them the accepted, frozen MAR slice, with two clients built against it.
   * This closes the same window while touching no clinical contract at all, and it closes it at
   * the only moment it is still cheap: before the ambiguity exists.
   *
   * ── UNCONDITIONAL, NOT "ONLY THE SECOND BRANCH" ─────────────────────────────
   * The first version fired only at `current >= 1`, and a falsification exposed why that is wrong.
   * A legacy hospital with NO branches that creates one through this route gets an ordinary,
   * non-main branch; `seedMainBranch` then adds the Main Branch as its SECOND, the backfill
   * declines, and the window it was meant to close is open again. The dangerous act is creating a
   * branch while history is unadopted — at any count.
   *
   * It cannot deadlock the rollout: the Main Branch is upserted by `seedMainBranch` writing to the
   * collection directly, so the seed never passes through this service.
   *
   * Narrow where it matters — it fires only when unadopted rows actually exist, so a hospital
   * provisioned after ADR-0015 (Main Branch created during provisioning, before any clinical row)
   * never meets it. The remedy is one command, and it is in the message rather than in somebody's
   * memory.
   */
  const branchless = await branchlessRows(getTenantDb());
  if (Object.keys(branchless).length > 0) {
    throw new AppError("HMS-BRANCH-002", 409, "Historical records are not assigned to a site", {
      branchless,
      hint: "run `pnpm seed:migrate --all` to adopt them into the Main Branch, then create this branch",
      why: "once a hospital has more than one site, which site these rows belong to can no longer be inferred — and a record that carries no site is hidden from everyone working at one",
    });
  }

  try {
    return await repo.create({ ...input, code: input.code.toUpperCase(), isMain: false });
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That branch code is already in use", {
        code: input.code,
        hint: "branch codes are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export interface UpdateBranchInput {
  name?: string;
  status?: "active" | "inactive";
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  timezone?: string;
  gstin?: string;
}

export async function updateBranch(id: string, patch: UpdateBranchInput): Promise<repo.Branch> {
  const existing = await repo.findById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Branch not found", { id });

  // The main branch is the hospital's home site: it always exists and is always open. Deactivating
  // it would leave a user who has chosen no branch with nowhere to default to.
  if (existing.isMain && patch.status === "inactive") {
    throw new AppError("HMS-STATE-001", 422, "The main branch cannot be deactivated", {
      id,
      hint: "make another branch the primary site first (not yet supported), or leave this one active",
    });
  }

  const updated = await repo.update(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Branch not found", { id });
  return updated;
}

/**
 * The zone a site's clock runs in — the only correct source for ANY clinical day boundary.
 *
 * ── WHY THIS LIVES HERE, AND WHY IT IS SHARED ───────────────────────────────
 * This function existed as three byte-identical private copies (`wardZone`) in `mar.service`,
 * `medicationRound` and `worklist`, and the reception register needed a fourth. Four private
 * copies of the rule that decides which day a clinical event belongs to is exactly the
 * duplicate-implementation risk the governance layer exists to catch (risk A1): they agree today
 * and nothing makes them agree tomorrow, and the symptom of a divergence is a dose or a visit
 * filed under the wrong date rather than an error anyone sees.
 *
 * It belongs to `branches` because the timezone is branch DATA and this module owns that store.
 * Callers already import `getBranch` from here, so no new dependency edge is created.
 *
 * ── THE FALLBACK IS DELIBERATE, AND IT IS NOT AN ERROR PATH ─────────────────
 * No branch means no site was selected — the aggregate view, or a record written before branches
 * existed. There is no single correct clock for "all sites", so the hospital default is the
 * honest answer rather than a guess at one of them.
 *
 * `zoneOrDefault` then absorbs a branch whose stored zone this runtime cannot format in. The edge
 * validates new zones and refuses bad ones; this keeps one bad legacy row from turning every day
 * boundary at that site into a 500. Wrong by at most a day boundary beats a ward that cannot
 * discharge anybody — see `core/time/zone.ts`.
 */
export async function branchZone(branchId?: string): Promise<string> {
  if (!branchId) return env.DEFAULT_TIMEZONE;
  const branch = await repo.findById(branchId).catch(() => undefined);
  return zoneOrDefault(branch?.timezone, env.DEFAULT_TIMEZONE);
}
