/**
 * Audit chain CLI (Doc 02 A5, Doc 09 §9) — seal and verify the tamper-evident trail.
 *
 *   pnpm --filter @medicore/api audit:chain -- --seal            # every hospital
 *   pnpm --filter @medicore/api audit:chain -- --seal --slug demo
 *   pnpm --filter @medicore/api audit:chain -- --verify --slug demo
 *
 * `--seal` is the periodic anchoring job (SCHEDULER_CATALOG: nightly). It is
 * idempotent and safe to run at any time — it seals only what is old enough to be
 * settled and not already sealed.
 *
 * `--verify` recomputes every hash and every anchor and reports anything that does
 * not reconcile. It exits non-zero when the trail does not verify, so it can be a
 * cron job whose failure is an alert: a hospital whose audit trail stops verifying
 * is an incident, not a report.
 *
 * This is a CLI rather than a route on purpose. Sealing is a single-writer job —
 * two concurrent sealers would fork the chain — and an HTTP endpoint is exactly
 * the kind of thing that gets called twice.
 */
import { createLogger } from "@medicore/logger";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { sealAuditRange, verifyAuditChain } from "../core/audit/auditChain.js";
import { getBySlug, listServable, type TenantRegistryEntry } from "../modules/tenants/index.js";

const logger = createLogger({ service: "audit-cli" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function withTenant<T>(tenant: TenantRegistryEntry, fn: () => Promise<T>): Promise<T> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  return runWithContext(
    {
      traceId: `audit-cli-${tenant.slug}`,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
    },
    fn,
  );
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const seal = process.argv.includes("--seal");
  const verify = process.argv.includes("--verify");

  if (!seal && !verify) {
    console.error("Usage: audit --seal [--slug <slug>]   |   audit --verify [--slug <slug>]");
    process.exit(1);
  }

  const tenants = slug
    ? await (async () => {
        const one = await getBySlug(slug);
        if (!one) throw new Error(`no tenant with slug "${slug}"`);
        return [one];
      })()
    : await listServable();

  let failures = 0;

  for (const tenant of tenants) {
    if (seal) {
      const result = await withTenant(tenant, sealAuditRange);
      if (result.sealed) {
        logger.info(
          {
            slug: tenant.slug,
            anchor: result.index,
            range: `${String(result.fromSeq)}–${String(result.toSeq)}`,
            entries: result.count,
            root: result.rootHash?.slice(0, 16),
          },
          "audit range sealed",
        );
      } else {
        logger.info({ slug: tenant.slug }, "nothing new to seal");
      }
    }

    if (verify) {
      const result = await withTenant(tenant, verifyAuditChain);
      if (result.ok) {
        logger.info(
          { slug: tenant.slug, anchors: result.anchors, entries: result.entriesVerified },
          "audit chain verified — no tampering detected",
        );
      } else {
        failures++;
        logger.error(
          { slug: tenant.slug, problems: result.problems },
          "AUDIT CHAIN DOES NOT VERIFY — the trail has been altered since it was sealed",
        );
      }
    }
  }

  // A failed verification must fail the process, or a cron job will report success
  // while a hospital's evidence quietly rots.
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "audit CLI failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
