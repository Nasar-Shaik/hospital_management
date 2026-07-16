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
import { seedPlans } from "../modules/subscriptions/index.js";

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

interface Outcome {
  slug: string;
  migrations: string[];
  permissionsAdded: number;
  roles: number;
  templatesAdded: number;
  tariffAdded: number;
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

  return {
    slug: tenant.slug,
    migrations,
    permissionsAdded: seeded.permissionsAdded,
    roles: seeded.roles.length,
    templatesAdded,
    tariffAdded,
  };
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const all = process.argv.includes("--all");

  if (!slug && !all) {
    console.error("Usage: migrate --all | --slug <slug>");
    process.exit(1);
  }

  // Platform-level first: the plan catalog lives in the master DB and is a
  // projection of the code-defined editions (Doc 07). A tenant cannot be put on a
  // plan that does not exist yet.
  const plans = await seedPlans();
  logger.info({ plans }, "plan catalog synced");

  const targets = slug
    ? await (async () => {
        const tenant = await getBySlug(slug);
        if (!tenant) throw new Error(`no tenant with slug "${slug}"`);
        return [tenant];
      })()
    : await allTenants();

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
