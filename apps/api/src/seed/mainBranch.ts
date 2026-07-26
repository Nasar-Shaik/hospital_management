/**
 * Ensures every tenant has its **Main Branch**, and that pre-branch operational records belong to it
 * (ADR-0015, backward compatibility STEP 8).
 *
 * Runs from provisioning (a new tenant is born with a Main Branch) AND from the fleet `migrate --all`
 * (an existing tenant, created before branches, gets one). Both are idempotent:
 *   - the branch is upserted on `{ tenantId, isMain: true }`, so re-running never makes a second one;
 *   - the backfill only touches rows that have NO `branchId` yet, so it is a no-op the second time.
 *
 * Seeded here rather than in the migration because a migration has no tenant context (no `tenantId`),
 * and the Main Branch — like every other row — must carry one. This mirrors how `siteSettings`,
 * `tariff` and `formulary` are seeded: idempotent, context-bound, safe to re-run on every release.
 *
 * The backfill is ADDITIVE (it sets a missing field), never destructive — so it needs no §3.9
 * approval. It matters most the day a tenant adds a SECOND branch: without it, every historical
 * encounter would belong to no branch and a branch-confined user would not see the hospital's past.
 */
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getBranchModel } from "../modules/branches/index.js";

const logger = createLogger({ service: "seed-main-branch" });

/**
 * The operational collections whose rows belong to the branch they happened at. Each pre-branch row
 * is adopted by the Main Branch. Identity (allergies — person-level), configuration (serviceItems,
 * medicines, roles, featureFlags) and the wallet balance (patient-level) are deliberately absent:
 * they are not per-branch transactions.
 */
const BACKFILL_COLLECTIONS = [
  "patients",
  "encounters",
  "appointments",
  "orders",
  "prescriptions",
  "dispenses",
  "charges",
  "invoices",
  "vitals",
  "wardNotes",
  "reportFiles",
] as const;

export interface SeedMainBranchResult {
  /** The Main Branch's id — its `branchId` value, used by the backfill. */
  branchId: string;
  created: boolean;
  /** How many pre-branch rows were adopted, per collection (only non-zero entries). */
  backfilled: Record<string, number>;
}

export async function seedMainBranch(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<SeedMainBranchResult> {
  return runWithContext(
    { traceId: `seed-branch-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const Branch = getBranchModel(connection);

      // Existence is checked BEFORE the upsert so "created" is a fact, not a guess.
      const existing = await Branch.findOne({ tenantId, isMain: true }).lean<{
        _id: { toString(): string };
      }>();

      // `$setOnInsert` so a re-run never rewrites a name an admin edited.
      const result = await Branch.findOneAndUpdate(
        { tenantId, isMain: true },
        {
          $setOnInsert: {
            tenantId,
            name: "Main Branch",
            code: "MAIN",
            status: "active",
            isMain: true,
          },
        },
        { upsert: true, new: true },
      ).lean<{ _id: { toString(): string } }>();

      if (!result?._id) throw new Error("main branch upsert returned nothing");
      const branchId = result._id.toString();
      const created = !existing;

      // Adopt pre-branch rows. Raw collection writes on purpose: this backfills historical data and
      // must not fire audit hooks or bump `version` on thousands of untouched-by-a-human records.
      const backfilled: Record<string, number> = {};
      for (const name of BACKFILL_COLLECTIONS) {
        const res = await connection
          .collection(name)
          .updateMany({ branchId: { $exists: false } }, { $set: { branchId } });
        if (res.modifiedCount > 0) backfilled[name] = res.modifiedCount;
      }

      if (created || Object.keys(backfilled).length > 0) {
        logger.info({ tenantSlug, branchId, created, backfilled }, "main branch ensured");
      }
      return { branchId, created, backfilled };
    },
  );
}
