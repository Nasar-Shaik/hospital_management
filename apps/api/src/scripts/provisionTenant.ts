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
import { ORGANIZATION_TYPES, type OrganizationType } from "@medicore/permissions";
import { env } from "../config/env.js";
import { provisionTenant, policyOf } from "../modules/tenants/index.js";
import { seedTenantAdmin } from "../seed/seedTenantAdmin.js";
import { seedNotificationTemplates } from "../seed/notificationTemplates.js";
import { seedTariff } from "../seed/tariff.js";
import { seedFormulary } from "../seed/formulary.js";
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
        "                 [--plan PLAN_CLINIC] [--org-type government_hospital] [--trial]\n" +
        "                 [--admin-email admin@apollo.com]\n" +
        "                 [--admin-name \"Dr Rao\"] [--admin-password '…']\n\n" +
        "Omit --admin-password and a strong one is generated and printed ONCE.",
    );
    process.exit(1);
  }

  const orgType = arg("--org-type") as OrganizationType | undefined;
  if (orgType && !ORGANIZATION_TYPES.includes(orgType)) {
    throw new Error(
      `--org-type must be one of: ${ORGANIZATION_TYPES.join(", ")} (got "${orgType}")`,
    );
  }

  const result = await provisionTenant({
    hospitalName,
    slug,
    ...(customDomain ? { customDomain } : {}),
    ...(planCode ? { planCode } : {}),
    ...(orgType ? { organizationType: orgType } : {}),
    trial,
  });

  logger.info(
    {
      tenantId: result.tenant.id,
      slug: result.tenant.slug,
      database: result.tenant.databaseName,
      status: result.tenant.status,
      // The policy this hospital will actually run on — derived from its type, not
      // stored as a copy. Logged at birth because "why is this hospital billing
      // patients ₹0?" should be answerable without reading code.
      organizationType: result.tenant.organizationType ?? "private_hospital (default)",
      policy: policyOf(result.tenant),
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

  // The messages this hospital sends its patients. Seeded at birth so the first
  // booking is confirmed — a hospital whose first patient got silence because a
  // template was missing would be right to distrust everything after it.
  const templates = await seedNotificationTemplates(
    result.tenant.id,
    result.tenant.slug,
    connection,
  );
  logger.info({ templates }, "notification templates seeded");

  // The price list. Seeded at birth for the same reason: an order for a test with no
  // tariff entry posts at 0, which looks like it works right up until a bill is read.
  const tariff = await seedTariff(result.tenant.id, result.tenant.slug, connection);
  logger.info({ tariff }, "tariff seeded");

  // The medicine master, mirroring the pharmacy tariff by code, so dispensing decrements a real
  // shelf. Reference data only (zero stock) — a pharmacist receives the actual quantities.
  const formulary = await seedFormulary(result.tenant.id, result.tenant.slug, connection);
  logger.info({ formulary }, "formulary seeded");

  if (admin.generatedPassword) {
    // Deliberately on stdout, not through the logger: logs are shipped, indexed
    // and retained. A one-time credential must not become a log record.
    process.stdout.write(
      "\n" +
        "  ┌─ First-login credentials (shown once — not recoverable) ─┐\n" +
        `     URL       ${signInUrl(slug)}\n` +
        `     Email     ${admin.email}\n` +
        `     Password  ${admin.generatedPassword}\n` +
        "     The administrator must change this at first login.\n" +
        "  └───────────────────────────────────────────────────────────┘\n\n",
    );
  }
}

/**
 * The address this hospital is actually reachable at — printed, so the operator
 * never has to guess or assemble it.
 *
 * It is derived from `TENANT_BASE_DOMAIN` (which defaults to `localhost`), NOT
 * from a hardcoded production domain: a CLI that prints
 * `https://demo.paperlesstech.in` on a developer's laptop is telling them to
 * browse the live server. Locally that means `http` and the web port; in
 * production it means `https` on the gateway, with no port at all.
 */
function signInUrl(slug: string): string {
  const domain = env.TENANT_BASE_DOMAIN;
  const local = domain === "localhost" || domain.endsWith(".localhost");
  if (!local) return `https://${slug}.${domain}`;

  // The port the BROWSER uses (the web app), not the API's — this is a link for a human.
  const webPort = process.env.WEB_PORT ?? "3000";
  return `http://${slug}.${domain}:${webPort}`;
}

main()
  .catch((err) => {
    logger.error({ err }, "provisioning failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
