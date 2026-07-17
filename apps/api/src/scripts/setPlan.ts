/**
 * Plan-change CLI (Doc 02 A2).
 *
 * Changing a hospital's edition is an OPERATOR action. `plan:manage` is a global
 * permission granted to no hospital role, precisely so a customer cannot upgrade
 * itself into software it has not paid for — which means there has to be a path
 * for us, and this is it until the operator console exists.
 *
 * A downgrade that would put the tenant over a limit is refused rather than
 * silently leaving them in violation.
 *
 *   pnpm --filter @medicore/api plan -- --slug demo --plan PLAN_HOSPITAL
 *   pnpm --filter @medicore/api plan -- --list
 */
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { getBySlug } from "../modules/tenants/index.js";
import {
  changePlan,
  getSubscription,
  listPlans,
  seedPlans,
} from "../modules/subscriptions/index.js";

const logger = createLogger({ service: "plan-cli" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  await seedPlans();

  if (process.argv.includes("--list")) {
    for (const plan of await listPlans()) {
      const limits = Object.entries(plan.limits)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
      process.stdout.write(
        `${plan.code.padEnd(20)} ${plan.name.padEnd(18)} ${String(plan.entitlements.length).padStart(2)} features  ${limits}\n`,
      );
    }
    return;
  }

  const slug = arg("--slug");
  const planCode = arg("--plan");

  if (!slug || !planCode) {
    console.error("Usage: plan --slug <slug> --plan <PLAN_CODE>   |   plan --list");
    process.exit(1);
  }

  const tenant = await getBySlug(slug);
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);

  // Usage counting reads the tenant's own database, so this needs a context.
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  const view = await runWithContext(
    { traceId: `plan-${slug}`, tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    async () => {
      await changePlan(tenant.id, planCode.toUpperCase());
      return getSubscription(tenant.id);
    },
  );

  logger.info(
    {
      slug,
      plan: view.planCode,
      features: view.features.length,
      usage: view.usage.map((u) => `${u.metric} ${String(u.used)}/${String(u.limit ?? "∞")}`),
    },
    "plan changed",
  );
}

main()
  .catch((err: unknown) => {
    // A refused downgrade is expected operator feedback, not a crash — print the
    // reason rather than a stack trace.
    const details = (err as { details?: { hint?: string } }).details;
    if (details?.hint) {
      logger.error({ hint: details.hint }, "plan change refused");
    } else {
      logger.error({ err }, "plan change failed");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
