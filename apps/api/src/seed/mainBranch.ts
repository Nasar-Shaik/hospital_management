/**
 * Ensures every tenant has its **Main Branch**, and that pre-branch operational records belong to it
 * (ADR-0015, backward compatibility STEP 8).
 *
 * Runs from provisioning — BOTH paths, the CLI and `createHospital` — and from the fleet
 * `migrate --all` (an existing tenant, created before branches, gets one). All are idempotent:
 *   - the branch is upserted on `{ tenantId, isMain: true }`, so re-running never makes a second one;
 *   - the backfill only touches rows that have NO `branchId` yet, so it is a no-op the second time;
 *   - and the backfill DECLINES entirely once the tenant has more than one branch, because from
 *     then on "which site was this?" is a question, not an inference. See the guard below.
 *
 * Seeded here rather than in the migration because a migration has no tenant context (no `tenantId`),
 * and the Main Branch — like every other row — must carry one. This mirrors how `siteSettings`,
 * `tariff` and `formulary` are seeded: idempotent, context-bound, safe to re-run on every release.
 *
 * The backfill is ADDITIVE (it sets a missing field), never destructive — so it needs no §3.9
 * approval. It matters most the day a tenant adds a SECOND branch: without it, every historical
 * encounter would belong to no branch and a branch-confined user would not see the hospital's past.
 */
import type { Connection, Types } from "mongoose";
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";

const logger = createLogger({ service: "seed-main-branch" });

/**
 * The `branches` collection by NAME, not through `getBranchModel`.
 *
 * This is what lets `provisionTenant` call this seed. The model route would import
 * `modules/branches/index.js`, whose service imports `modules/tenants` (for the plan's branch
 * cap) — so a tenant that seeded its own Main Branch would close a cycle:
 * tenants → seed → branches → tenants, which `no-circular` rejects and which is, independently,
 * the wrong shape. `core/context/activeBranch.ts` reads this same collection the same way and
 * for the same reason.
 *
 * The cost is the model's conveniences, which are supplied here instead: timestamps by hand, and
 * no audit row. The second is deliberate — a Main Branch is not created by a person, it is part
 * of what provisioning MEANS, and provisioning is already audited on both sides
 * (`platform.hospital.created` and `hospital.provisioned`).
 */
interface BranchRow {
  _id: Types.ObjectId;
  tenantId: string;
  isMain: boolean;
}

/**
 * The collections whose rows belong to the branch they happened at, or were catalogued at. Each
 * pre-branch row is adopted by the Main Branch — but ONLY under the single-branch guard below.
 *
 * Deliberately ABSENT, and each for its own reason:
 *   - `allergies`            — person-level safety data, tenant-wide by design (ADR-0015).
 *   - `walletAccounts`       — the patient's BALANCE, tenant-wide; only the `walletEntries`
 *                              ledger records which desk the money crossed.
 *   - `medicines`            — the formulary is master data; the hospital stocks a drug, not a
 *                              site. (Its stock LEVEL is tenant-wide too — see PROJECT-STATUS.)
 *   - `notificationTemplates`, `serviceItems`, `roles`, `featureFlags`, `departments`
 *                            — configuration, shared across sites.
 *   - `doctorLeave`          — a doctor who is away is away from the whole hospital; leave
 *                              suppresses slots at every site, which is the fail-safe reading.
 */
const BACKFILL_COLLECTIONS = [
  // Clinical & front-office flow
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
  "consultationNotes",
  "medicationAdministrations",
  "documents",
  "consents",
  "deathRecords",
  "mortuaryRegister",
  "feedbackTickets",
  // Ledgers: the row records WHERE the movement happened; the running balance stays tenant-wide.
  "walletEntries",
  "stockMovements",
  // Per-site catalogue and rosters — a ward, a bed and a clinic session belong to one site.
  "wards",
  "rooms",
  "beds",
  "theatres",
  "otBookings",
  "ambulances",
  "ambulanceTrips",
  "assets",
  "assetMaintenance",
  "labTests",
  "doctorSchedules",
  "doctorAvailability",
  // Operational records that happen to be site-flavoured
  "notifications",
  "insurancePolicies",
  "insuranceClaims",
] as const;

/**
 * The collections where a MISSING `branchId` actually hides the row (risk register D11/D12).
 *
 * ── WHY THIS IS A SUBSET AND NOT SIMPLY `BACKFILL_COLLECTIONS` ──────────────
 * A branchless row is only a problem where something FILTERS on the field. These three declare
 * `branchId` optional AND narrow their reads through `scopeFilter()`, so a row the backfill never
 * reached is invisible to anyone with a branch selected:
 *
 *   `reportFiles`                 — `listForPatient`            (D11)
 *   `medicationAdministrations`   — three reads in `mar.repository.ts` (D12)
 *   `wardNotes`                   — `listForEncounter`
 *
 * On the MAR that means a dose that was given reading as never given, and the next nurse giving
 * it again. That is what `createBranch` refuses over.
 *
 * ── THE COLLECTIONS DELIBERATELY LEFT OUT, AND THE ONE THAT PROVED IT ───────
 * Scanning all of `BACKFILL_COLLECTIONS` was the first attempt and it was wrong. Migration
 * 0047 states outright that some rows stay branchless FOREVER by design — "a wallet DEPOSIT or
 * REFUND with no invoice and no encounter (cash at a desk, and which desk is genuinely
 * unrecorded)… Inventing a site for them would put a number in a financial ledger that nobody
 * can defend". Measured: the branch-isolation suite hit exactly that, one branchless
 * `walletEntries` row, and a hospital carrying one would have been blocked from ever opening a
 * second site. A guard that cannot be satisfied is an outage.
 *
 * Those rows are harmless because nothing filters them out: `listEntries` and the balance are
 * hospital-wide on purpose. Same for the rest of the backfill list — either `branchId` is
 * `required: true` (so a branchless row cannot exist) or no read narrows on it.
 *
 * Keep this list in step with reality: a collection joins it when a read starts filtering on an
 * optional `branchId`, and leaves it when the field becomes required.
 */
const HIDDEN_IF_BRANCHLESS = [
  "reportFiles",
  "medicationAdministrations",
  "wardNotes",
] as const satisfies readonly (typeof BACKFILL_COLLECTIONS)[number][];

/**
 * Rows that would be HIDDEN by their own module because they carry no branch.
 *
 * `createBranch` calls this before letting a hospital open another site, so the window closes at
 * the only moment it can still be closed cheaply — before "which site was this?" becomes
 * unanswerable. The tenant needs no predicate: this is a per-tenant database (ADR-0005).
 */
export async function branchlessRows(connection: Connection): Promise<Record<string, number>> {
  const branchless: Record<string, number> = {};
  for (const name of HIDDEN_IF_BRANCHLESS) {
    const n = await connection.collection(name).countDocuments({ branchId: { $exists: false } });
    if (n > 0) branchless[name] = n;
  }
  return branchless;
}

/** Every unadopted row the backfill would have taken — the broad view, for its own report. */
async function allBranchlessRows(connection: Connection): Promise<Record<string, number>> {
  const branchless: Record<string, number> = {};
  for (const name of BACKFILL_COLLECTIONS) {
    const n = await connection.collection(name).countDocuments({ branchId: { $exists: false } });
    if (n > 0) branchless[name] = n;
  }
  return branchless;
}

export interface SeedMainBranchResult {
  /** The Main Branch's id — its `branchId` value, used by the backfill. */
  branchId: string;
  created: boolean;
  /** How many pre-branch rows were adopted, per collection (only non-zero entries). */
  backfilled: Record<string, number>;
  /**
   * Set when the backfill was DECLINED because the tenant already has more than one branch, with
   * the branchless rows found per collection. Nothing was written; these rows need a human.
   */
  skipped?: {
    reason: "multiple branches";
    branchCount: number;
    branchless: Record<string, number>;
  };
}

export async function seedMainBranch(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<SeedMainBranchResult> {
  return runWithContext(
    { traceId: `seed-branch-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const branches = connection.collection<BranchRow>("branches");

      // Existence is checked BEFORE the upsert so "created" is a fact, not a guess.
      const existing = await branches.findOne({ tenantId, isMain: true });

      const now = new Date();
      // `$setOnInsert` so a re-run never rewrites a name an admin edited.
      const result = await branches.findOneAndUpdate(
        { tenantId, isMain: true },
        {
          $setOnInsert: {
            tenantId,
            name: "Main Branch",
            code: "MAIN",
            status: "active",
            isMain: true,
            // Supplied by hand: the model's `timestamps` and plugin defaults are not in play
            // on a raw write, and a row missing them reads as corrupt to everything downstream.
            isDeleted: false,
            version: 0,
            schemaVersion: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      if (!result?._id) throw new Error("main branch upsert returned nothing");
      const branchId = result._id.toString();
      const created = !existing;

      /**
       * ── THE BACKFILL MAY ONLY RUN ON A SINGLE-SITE HOSPITAL ──────────────────
       * Adopting a branchless row into the Main Branch is an INFERENCE: "there was only one
       * site, so it happened there". That is sound while the hospital has one branch and
       * false the moment it has two — at which point this would be inventing a fact, writing
       * Hyderabad onto a row that might be Chennai's, permanently and unprovably.
       *
       * So the guard is the branch COUNT, not the `created` flag: a tenant can acquire its
       * second branch between two runs of `migrate --all`, and the second run must decline
       * where the first was safe. Declined rows are counted and returned so the operator sees
       * exactly what needs a human decision instead of finding out from a wrong report.
       */
      const branchCount = await branches.countDocuments({ tenantId });
      if (branchCount > 1) {
        const branchless = await allBranchlessRows(connection);
        if (Object.keys(branchless).length > 0) {
          logger.warn(
            { tenantSlug, branchCount, branchless },
            "branchless rows left alone — this hospital has several branches, so which one " +
              "they belong to cannot be inferred. Assign them deliberately.",
          );
        }
        return {
          branchId,
          created,
          backfilled: {},
          skipped: { reason: "multiple branches", branchCount, branchless },
        };
      }

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
