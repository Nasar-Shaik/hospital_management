/**
 * Fleet migration / repair CLI (Doc 04 §7, RISK_REGISTER T2).
 *
 * Brings existing hospitals up to date after a release that adds a migration or
 * changes the permission catalog. Provisioning converges a NEW tenant; this is
 * what converges the ones already running.
 *
 * Without it, a tenant created before a feature silently lacks it — which is how
 * `hms_demo` ended up with an admin holding zero permissions after Phase 1C
 * shipped: the code was there, that database was not.
 *
 * Each tenant is migrated independently, and a failure on one does NOT stop the
 * others (risk T2) — one broken hospital must never block the fleet. The run
 * reports what it did and exits non-zero if anything failed.
 *
 *   pnpm --filter @medicore/api migrate -- --all
 *   pnpm --filter @medicore/api migrate -- --slug demo
 *   pnpm --filter @medicore/api migrate -- --check          # read-only; writes nothing
 */
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster, getMasterConnection } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { migrateTenant, getBySlug, type TenantRegistryEntry } from "../modules/tenants/index.js";
import { seedRbac } from "../modules/rbac/index.js";
import { seedNotificationTemplates } from "../seed/notificationTemplates.js";
import { seedTariff } from "../seed/tariff.js";
import { seedFormulary } from "../seed/formulary.js";
import { seedSiteSettings } from "../seed/siteSettings.js";
import { seedMainBranch } from "../seed/mainBranch.js";
import { seedPlans } from "../modules/subscriptions/index.js";
import { tenantMigrations } from "../core/db/migrations/tenantMigrations.js";
import { verifyTenantSchema } from "../seed/schemaGuard.js";

const logger = createLogger({ service: "migrate-cli" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/** Reads the registry directly — the fleet job is a platform operation. */
async function allTenants(): Promise<TenantRegistryEntry[]> {
  const master = await getMasterConnection();
  const docs = await master
    .collection("tenants")
    .find({ status: { $nin: ["purged", "terminated"] } })
    .toArray();

  return docs.map((d) => ({
    id: String(d._id),
    hospitalName: String(d.hospitalName),
    slug: String(d.slug),
    databaseName: String(d.databaseName),
    status: d.status as TenantRegistryEntry["status"],
    ...(d.dbUri ? { dbUri: String(d.dbUri) } : {}),
  }));
}

async function requireTenant(slug: string): Promise<TenantRegistryEntry> {
  const tenant = await getBySlug(slug);
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);
  return tenant;
}

interface Outcome {
  slug: string;
  migrations: string[];
  permissionsAdded: number;
  roles: number;
  templatesAdded: number;
  tariffAdded: number;
  formularyAdded: number;
  siteSeeded: boolean;
  mainBranchBackfilled?: number;
  error?: string;
}

async function converge(tenant: TenantRegistryEntry): Promise<Outcome> {
  // 1. Schema.
  const migrations = await migrateTenant(tenant.id);

  // 2. The code-defined catalog: permissions, default roles, and their grants.
  //    Idempotent, so re-running is safe and cheap.
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  const seeded = await runWithContext(
    {
      traceId: `migrate-${tenant.slug}`,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
    },
    async () => seedRbac(),
  );

  // 3. The notification templates. Also idempotent, and also here rather than only
  //    in `provisionTenant`: a template added in a later release must reach the
  //    hospitals that were provisioned BEFORE it existed, or they silently lose a
  //    message. It never overwrites wording a hospital has edited.
  const templatesAdded = await seedNotificationTemplates(tenant.id, tenant.slug, connection);
  const tariffAdded = await seedTariff(tenant.id, tenant.slug, connection);
  // The medicine master mirrors the pharmacy tariff (same codes) so a dispensed drug is the same
  // object the stock ledger decrements. Reference data only — zero stock, seeded on insert.
  const formularyAdded = await seedFormulary(tenant.id, tenant.slug, connection);
  // The public website. Seeded on insert only (never overwrites an admin's edits), so this both
  // backfills hospitals provisioned before the feature and leaves edited ones untouched.
  const siteSeeded = await seedSiteSettings(
    tenant.id,
    tenant.slug,
    connection,
    tenant.hospitalName,
  );
  // The Main Branch (ADR-0015). Idempotent: creates one for a tenant provisioned before branches
  // existed, and adopts its pre-branch operational rows into it. A no-op on the second run.
  const mainBranch = await seedMainBranch(tenant.id, tenant.slug, connection);

  return {
    slug: tenant.slug,
    migrations,
    permissionsAdded: seeded.permissionsAdded,
    roles: seeded.roles.length,
    templatesAdded,
    tariffAdded,
    formularyAdded,
    siteSeeded,
    mainBranchBackfilled: Object.values(mainBranch.backfilled).reduce((a, b) => a + b, 0),
  };
}

/**
 * ── IS THE FLEET ACTUALLY CONVERGED? (risk register T2) ──────────────────────
 * The register predicted this in July and scored it 12: "fleet migration failure leaves tenant DBs
 * on mixed schema versions", mitigated by a "convergence metric". On 2026-08-14 it materialised —
 * all four local tenants were two migrations behind and nothing said so, so a safety probe
 * reported seven catastrophic failures that were entirely the absent indexes.
 *
 * The predicted mitigation was a Prometheus gauge, `hms_migration_pending{tenant}`. That metric is
 * listed in OBSERVABILITY_GUIDE alongside about twenty others and **none of them exist**: this API
 * has no `prom-client`, no `/metrics` endpoint and no gauge registry. Building one for a single
 * number would mean standing up the whole observability layer as a side effect of a defect fix,
 * and that layer is scheduled work with its own design (P9).
 *
 * So this is the answer within the architecture that exists. The fleet loop is already here, the
 * per-tenant verdict is already written (`verifyTenantSchema`, which checks the canonical
 * `pendingCount` AND that the clinical invariants are actually armed in the database), and an exit
 * code is something a deploy step or a cron can read. What was missing was only a way to ASK
 * without also mutating — before this, finding out whether a tenant was behind meant running a
 * migration against it.
 *
 * This does not close T2. A gauge scraped every minute tells you at 03:00 that a tenant drifted;
 * a command tells you when someone runs it. It removes the specific failure that actually
 * happened — a stale tenant discovered through a clinical failure — and the register keeps the
 * rest open.
 */
async function checkFleet(targets: TenantRegistryEntry[]): Promise<void> {
  let behind = 0;
  /**
   * Tenants whose migrations are all RECORDED but whose constraints are gone — dropped by hand, or
   * restored from a backup taken before them. `migrate --all` skips a recorded migration and
   * reports success without touching the database, so telling this group to run it would send them
   * away believing they had fixed an unenforceable schema. They need the record cleared first.
   */
  const drifted: string[] = [];

  for (const tenant of targets) {
    try {
      const connection = await getTenantConnection({
        id: tenant.id,
        databaseName: tenant.databaseName,
        ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
      });
      const verdict = await verifyTenantSchema(connection, tenantMigrations);

      if (verdict.ok) {
        logger.info({ slug: tenant.slug }, "converged");
        continue;
      }

      behind += 1;
      if (verdict.pending.length === 0) drifted.push(tenant.slug);
      logger.error(
        {
          slug: tenant.slug,
          pending: verdict.pending,
          // Named, not counted: "1 missing" sends the reader back to the database, and the whole
          // point of a check is to hand over an answer rather than the next investigation.
          missing: verdict.missing.map((m) => ({ rule: m.invariant.rule, found: m.found })),
        },
        "NOT CONVERGED",
      );
    } catch (err) {
      // A tenant that cannot even be inspected is not "fine" — it is the loudest possible answer.
      behind += 1;
      logger.error(
        { slug: tenant.slug, err: err instanceof Error ? err.message : String(err) },
        "could not be inspected",
      );
    }
  }

  if (behind > 0) {
    logger.error(
      { behind, total: targets.length, drifted },
      drifted.length > 0
        ? "fleet is NOT converged. Tenants in `drifted` have the migration RECORDED but the " +
            "constraint absent, so `migrate --all` will skip them and report success without " +
            "changing anything — clear the record for the named migration on those first. The " +
            "rest converge with `migrate --all`. Then check again."
        : "fleet is NOT converged — run `migrate --all`, then check again",
    );
    process.exitCode = 1;
    return;
  }
  logger.info({ total: targets.length }, "fleet converged — every tenant, schema armed");
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const all = process.argv.includes("--all");
  const check = process.argv.includes("--check");

  if (!slug && !all && !check) {
    console.error("Usage: migrate --all | --slug <slug> | --check");
    process.exit(1);
  }

  if (check) {
    // Read-only: no plan sync, no seeding, no migration. Asking must never change the answer.
    await checkFleet(slug ? [await requireTenant(slug)] : await allTenants());
    return;
  }

  // Platform-level first: the plan catalog lives in the master DB and is a
  // projection of the code-defined editions (Doc 07). A tenant cannot be put on a
  // plan that does not exist yet.
  const plans = await seedPlans();
  logger.info({ plans }, "plan catalog synced");

  const targets = slug ? [await requireTenant(slug)] : await allTenants();

  logger.info({ tenants: targets.length }, "converging tenants");

  const results: Outcome[] = [];
  for (const tenant of targets) {
    try {
      results.push(await converge(tenant));
    } catch (err) {
      // One hospital's failure must not halt the fleet.
      results.push({
        slug: tenant.slug,
        migrations: [],
        permissionsAdded: 0,
        roles: 0,
        templatesAdded: 0,
        tariffAdded: 0,
        formularyAdded: 0,
        siteSeeded: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const result of results) {
    if (result.error) {
      logger.error({ slug: result.slug, err: result.error }, "tenant FAILED to converge");
    } else {
      logger.info(
        {
          slug: result.slug,
          migrationsApplied: result.migrations,
          permissionsAdded: result.permissionsAdded,
          roles: result.roles,
          templatesAdded: result.templatesAdded,
        },
        "tenant converged",
      );
    }
  }

  const failed = results.filter((r) => r.error).length;
  if (failed > 0) {
    logger.error({ failed, total: results.length }, "some tenants failed");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, "fleet migration failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
