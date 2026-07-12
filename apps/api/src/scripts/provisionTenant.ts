/**
 * Tenant provisioning CLI (BUSINESS_WORKFLOWS §13).
 *
 * Provisioning is an operator action, not a public endpoint — there is
 * deliberately no unauthenticated route that can create a hospital. The
 * super-admin HTTP surface (behind operator auth) lands with the master-realm
 * work; this script stays the ground truth for what provisioning does.
 *
 * This is the COMPOSITION ROOT for provisioning: it sequences the tenant module
 * (registry + database + migrations) and the seed (system roles + first admin),
 * so neither has to know about the other.
 *
 *   pnpm --filter @medicore/api provision -- --name "Apollo Hospital" --slug apollo \
 *        --admin-email admin@apollo.com
 */
import { createLogger } from "@medicore/logger";
import { provisionTenant } from "../modules/tenants/index.js";
import { seedTenantAdmin } from "../seed/seedTenantAdmin.js";
import { closeAllTenantConnections, getTenantConnection } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";

const logger = createLogger({ service: "provision-cli" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const hospitalName = arg("--name");
  const slug = arg("--slug");
  const customDomain = arg("--domain");
  const planCode = arg("--plan");
  const adminEmail = arg("--admin-email");
  const adminName = arg("--admin-name");
  const adminPassword = arg("--admin-password");
  const trial = process.argv.includes("--trial");

  if (!hospitalName || !slug) {
    console.error(
      'Usage: provision --name "Apollo Hospital" --slug apollo [--domain hms.apollo.com]\n' +
        "                 [--plan PLAN_CLINIC] [--trial] [--admin-email admin@apollo.com]\n" +
        "                 [--admin-name \"Dr Rao\"] [--admin-password '…']\n\n" +
        "Omit --admin-password and a strong one is generated and printed ONCE.",
    );
    process.exit(1);
  }

  const result = await provisionTenant({
    hospitalName,
    slug,
    ...(customDomain ? { customDomain } : {}),
    ...(planCode ? { planCode } : {}),
    trial,
  });

  logger.info(
    {
      tenantId: result.tenant.id,
      slug: result.tenant.slug,
      database: result.tenant.databaseName,
      status: result.tenant.status,
      migrationsApplied: result.migrationsApplied,
    },
    "tenant provisioned",
  );

  // Seed system roles + the first administrator, so the hospital can actually be
  // logged into. Without this a provisioned tenant is a database nobody can enter.
  const connection = await getTenantConnection({
    id: result.tenant.id,
    databaseName: result.tenant.databaseName,
    ...(result.tenant.dbUri ? { dbUri: result.tenant.dbUri } : {}),
  });

  const admin = await seedTenantAdmin({
    tenantId: result.tenant.id,
    tenantSlug: result.tenant.slug,
    connection,
    email: adminEmail ?? `admin@${slug}.example.com`,
    ...(adminName ? { name: adminName } : {}),
    ...(adminPassword ? { password: adminPassword } : {}),
  });

  logger.info({ userId: admin.userId, email: admin.email, created: admin.created }, "admin seeded");

  if (admin.generatedPassword) {
    // Deliberately on stdout, not through the logger: logs are shipped, indexed
    // and retained. A one-time credential must not become a log record.
    process.stdout.write(
      "\n" +
        "  ┌─ First-login credentials (shown once — not recoverable) ─┐\n" +
        `     URL       https://${slug}.${process.env.TENANT_BASE_DOMAIN ?? "paperlesstech.in"}\n` +
        `     Email     ${admin.email}\n` +
        `     Password  ${admin.generatedPassword}\n` +
        "     The administrator must change this at first login.\n" +
        "  └───────────────────────────────────────────────────────────┘\n\n",
    );
  }
}

main()
  .catch((err) => {
    logger.error({ err }, "provisioning failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
