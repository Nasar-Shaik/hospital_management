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
 *   pnpm --filter @medicore/api migrate -- --check --json   # one document on stdout, for a deploy step
 *
 * `--check` is the RELEASE GATE (DEPLOYMENT_GATE.md). Exit 0 READY · 1 NOT_READY · 2 ERROR.
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
import { seedIcdCodes } from "../seed/icdCodes.js";
import { seedFormulary } from "../seed/formulary.js";
import { seedSiteSettings } from "../seed/siteSettings.js";
import { seedMainBranch } from "../seed/mainBranch.js";
import { seedPlans } from "../modules/subscriptions/index.js";
import { tenantMigrations } from "../core/db/migrations/tenantMigrations.js";
import {
  checkTenant,
  malformed,
  report,
  validateTarget,
  EXIT_CODE,
  type FleetReport,
  type TenantReadiness,
} from "../seed/deploymentGate.js";

// In `--json` the report IS the output: pino writes to stdout too, and two JSON dialects on one
// stream is not machine-readable, it is a parsing puzzle. Decided before the logger is built.
const asJson = process.argv.includes("--json");
const logger = createLogger({ service: "migrate-cli", ...(asJson ? { level: "silent" } : {}) });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/**
 * Reads the registry directly — the fleet job is a platform operation.
 *
 * Returns the RAW documents. Coercing them here is how a row missing `databaseName` became the
 * string `"undefined"` and then a real, empty database of that name; validation belongs to the
 * caller, which can report a bad row instead of inventing a plausible-looking one.
 */
async function allTenantRows(): Promise<Record<string, unknown>[]> {
  const master = await getMasterConnection();
  const docs = await master
    .collection("tenants")
    .find({ status: { $nin: ["purged", "terminated"] } })
    .toArray();
  return docs.map((d) => ({ ...d, id: String(d._id) }));
}

async function requireTenant(slug: string): Promise<TenantRegistryEntry> {
  const tenant = await getBySlug(slug);
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);
  return tenant;
}

/**
 * The convergence targets — same rows, same validation, but a malformed one is REFUSED rather
 * than reported. `--check` may safely inspect a database named `undefined`; `--all` would create
 * one and run forty-nine migrations into it. The read path can tolerate a bad row, the write path
 * cannot.
 */
async function migratableTenants(): Promise<TenantRegistryEntry[]> {
  const targets: TenantRegistryEntry[] = [];
  for (const row of await allTenantRows()) {
    const validated = validateTarget(row);
    if (!validated.ok) {
      logger.error(
        { slug: validated.slug, problems: validated.problems },
        "SKIPPED — this registry row is not safe to migrate. Fix it, then re-run.",
      );
      process.exitCode = EXIT_CODE.ERROR;
      continue;
    }
    targets.push({
      id: validated.target.id,
      hospitalName: String(row.hospitalName ?? validated.target.slug),
      slug: validated.target.slug,
      databaseName: validated.target.databaseName,
      status: row.status as TenantRegistryEntry["status"],
      ...(validated.target.dbUri ? { dbUri: validated.target.dbUri } : {}),
    });
  }
  return targets;
}

interface Outcome {
  slug: string;
  migrations: string[];
  permissionsAdded: number;
  roles: number;
  templatesAdded: number;
  tariffAdded: number;
  formularyAdded: number;
  icdAdded: number;
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
  // The ICD-10 starter set. Backfills every hospital provisioned before it existed — which, until
  // this release, was all of them: the code master shipped empty, so Medical Records was a blank
  // page and the disease register could only report zero. Insert-only, so a curated master is safe.
  const icdAdded = await seedIcdCodes(tenant.id, tenant.slug, connection);

  return {
    slug: tenant.slug,
    migrations,
    permissionsAdded: seeded.permissionsAdded,
    roles: seeded.roles.length,
    templatesAdded,
    tariffAdded,
    formularyAdded,
    icdAdded,
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
 * So this is the answer within the architecture that exists: the fleet loop, the per-tenant
 * verdict (`verifyTenantSchema`), and an exit code a deploy step can read. The judgement of what
 * each verdict MEANS lives in `deploymentGate.ts` rather than here, because logic inside a script
 * is logic no test can reach — and this one decides whether a release ships.
 *
 * This does not close T2. A gauge scraped every minute tells you at 03:00 that a tenant drifted;
 * a command tells you when someone runs it.
 */
async function checkFleet(rows: Record<string, unknown>[], asJson: boolean): Promise<void> {
  const results: TenantReadiness[] = [];

  /**
   * Sequential, deliberately. The fleet is four tenants and the whole walk costs ~20ms, so a
   * worker pool would be machinery bought with complexity and paid for in nothing. `checkTenant`
   * is independent per tenant and returns a value rather than mutating shared state, so bounded
   * concurrency is a `map` with a semaphore on the day the fleet is large enough to want one.
   */
  for (const row of rows) {
    const validated = validateTarget(row);
    if (!validated.ok) {
      results.push(malformed(validated.slug, validated.problems));
      continue;
    }
    results.push(
      await checkTenant(
        validated.target,
        (t) =>
          getTenantConnection({
            id: t.id,
            databaseName: t.databaseName,
            ...(t.dbUri ? { dbUri: t.dbUri } : {}),
          }),
        tenantMigrations,
      ),
    );
  }

  emit(report(results, tenantMigrations), asJson);
}

/**
 * ── THE MACHINE-READABLE FORM IS THE POINT ──────────────────────────────────
 * A deploy step should not have to grep log lines to find out whether it may proceed. In `--json`
 * the logger is silenced (pino writes to stdout too) so stdout holds EXACTLY one document and
 * `jq -e '.verdict == "READY"'` is the whole integration.
 */
function emit(result: FleetReport, asJson: boolean): void {
  process.exitCode = EXIT_CODE[result.verdict];

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  for (const tenant of result.tenants) {
    const line = {
      slug: tenant.slug,
      code: tenant.code,
      ...(tenant.notes.length ? { notes: tenant.notes } : {}),
    };
    if (tenant.ready) logger.info(line, "ready");
    else logger.error({ ...line, detail: tenant.detail, remedy: tenant.remedy }, tenant.code);
  }

  const counts = {
    total: result.total,
    ready: result.ready,
    notReady: result.notReady,
    errored: result.errored,
  };
  if (result.verdict === "READY") {
    logger.info(counts, "READY — every tenant is on this release's schema, and it is armed");
  } else if (result.verdict === "NOT_READY") {
    logger.error(counts, "NOT_READY — do not roll out. Each tenant above carries its own remedy.");
  } else {
    logger.error(
      counts,
      "ERROR — the fleet could not be fully inspected, so nothing is known about the tenants " +
        "that failed. This is NOT a schema finding; do not converge on the strength of it.",
    );
  }
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const all = process.argv.includes("--all");
  const check = process.argv.includes("--check");

  if (!slug && !all && !check) {
    console.error("Usage: migrate --all | --slug <slug> | --check [--json]");
    process.exit(1);
  }

  if (check) {
    // Read-only: no plan sync, no seeding, no migration. Asking must never change the answer.
    let rows: Record<string, unknown>[];
    if (slug) {
      const tenant = await getBySlug(slug);
      if (!tenant) {
        // Named a tenant that does not exist. NOT a schema finding — the gate was pointed at
        // nothing, and answering READY (vacuously true of an empty set) would be the worst
        // possible outcome for a deploy step that typoed a slug.
        emit(
          report(
            [
              malformed(slug, [
                `no tenant with slug "${slug}" in the registry — nothing was checked`,
              ]),
            ],
            tenantMigrations,
          ),
          asJson,
        );
        return;
      }
      rows = [{ ...tenant, id: tenant.id }];
    } else {
      rows = await allTenantRows();
    }

    /**
     * ── AN EMPTY FLEET IS NOT A PASS ────────────────────────────────────────
     * "Every tenant is ready" is vacuously true of zero tenants, so the natural implementation
     * exits 0 on an unreachable-but-connected master, a wrong `MONGO_MASTER_DB`, or a registry
     * that has not been seeded. A release gate whose happiest answer is "I found nothing to
     * check" is worse than no gate.
     */
    if (rows.length === 0) {
      emit(
        report(
          [malformed("(fleet)", ["the registry returned no tenants — nothing was checked"])],
          tenantMigrations,
        ),
        asJson,
      );
      return;
    }

    await checkFleet(rows, asJson);
    return;
  }

  // Platform-level first: the plan catalog lives in the master DB and is a
  // projection of the code-defined editions (Doc 07). A tenant cannot be put on a
  // plan that does not exist yet.
  const plans = await seedPlans();
  logger.info({ plans }, "plan catalog synced");

  const targets = slug ? [await requireTenant(slug)] : await migratableTenants();

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
        icdAdded: 0,
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
