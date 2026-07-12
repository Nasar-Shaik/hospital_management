/**
 * Tenant provisioning CLI (BUSINESS_WORKFLOWS §13).
 *
 * Provisioning is an operator action, not a public endpoint. The super-admin HTTP
 * surface arrives with authentication in Phase 1B; until then this script is the
 * only way to create a hospital, which keeps an unauthenticated provisioning
 * route from ever existing.
 *
 *   pnpm --filter @medicore/api provision -- --name "Apollo Hospital" --slug apollo
 */
import { createLogger } from "@medicore/logger";
import { provisionTenant } from "../modules/tenants/index.js";
import { closeAllTenantConnections } from "../core/db/connectionManager.js";
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
  const trial = process.argv.includes("--trial");

  if (!hospitalName || !slug) {
    console.error(
      'Usage: provision --name "Apollo Hospital" --slug apollo [--domain hms.apollo.com] [--plan PLAN_CLINIC] [--trial]',
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
}

main()
  .catch((err) => {
    logger.error({ err }, "provisioning failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
