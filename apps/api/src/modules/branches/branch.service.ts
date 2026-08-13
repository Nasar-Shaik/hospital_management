/**
 * Branch service — creating, listing and editing a tenant's sites (ADR-0015).
 *
 * The number of branches a tenant may create is a PLATFORM control (`limits.maxBranches` on the
 * master record), read here through the tenants module's public interface — never by reaching into
 * the master DB, which a business module may not do (Constitution §5). The cap is enforced at the
 * one creation point, exactly like every other edition limit (HMS-PLAN-001).
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
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
