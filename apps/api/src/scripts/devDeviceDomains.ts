/**
 * Make every local hospital reachable from a PHONE, without moving the web app.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * `TENANT_BASE_DOMAIN=localhost` is right for a browser on this machine and useless to a handset:
 * `apollo.localhost` resolves to the PHONE's own loopback, so it never reaches this API. The
 * obvious fix — repointing `TENANT_BASE_DOMAIN` at a LAN-reachable domain — works for the phone and
 * breaks the browser, because that same value drives the dev CORS allowlist (`*.<domain>` in
 * `app.ts`). One or the other, and a mode switch to remember.
 *
 * ── WHY A CUSTOM DOMAIN IS THE RIGHT ANSWER ─────────────────────────────────
 * `resolveTenantFromHost` already tries the subdomain FIRST and falls back to a registered custom
 * domain. That fallback exists for hospitals that bring their own hostname — a real, tested
 * production path — and it is exactly the shape of this problem: a second hostname for a tenant
 * that already has one. So nothing in the middleware changes, nothing about tenancy is special-cased
 * for development, and both hosts resolve at the same time:
 *
 *   apollo.localhost:4000                → subdomain of TENANT_BASE_DOMAIN   (browser, simulator)
 *   apollo.192.168.1.7.sslip.io:4000     → registered custom domain          (phone)
 *
 * `sslip.io` answers `<anything>.<ip>.sslip.io` with that IP, so no hosts file and no DNS server.
 *
 *   pnpm --filter @medicore/api dev:device-domains          # attach, using this machine's IP
 *   pnpm --filter @medicore/api dev:device-domains --clear  # detach them all
 *
 * Re-run it after changing network — the addresses move with the IP. It refuses to run outside
 * development, because attaching a customer-visible hostname is an operator decision, not a script.
 */
import { networkInterfaces } from "node:os";
import { createLogger } from "@medicore/logger";
import { env } from "../config/env.js";
import { listServable, updateCustomDomain } from "../modules/tenants/tenant.repository.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";

const logger = createLogger({ service: "dev-device-domains" });

/** This machine's LAN address — the one a phone on the same wifi can route to. */
function lanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  // en0 is Wi-Fi on macOS. First, so a VPN tunnel or virtual adapter cannot supply an address the
  // phone has no route to — the failure that produces looks like a dead API rather than bad config.
  const ordered = [
    ...(interfaces.en0 ?? []),
    ...Object.entries(interfaces)
      .filter(([name]) => name !== "en0")
      .flatMap(([, addresses]) => addresses ?? []),
  ];
  return ordered.find((a) => a.family === "IPv4" && !a.internal)?.address;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error("dev:device-domains is a development convenience — never run it in production");
  }

  const clearing = process.argv.includes("--clear");
  const tenants = await listServable();

  if (tenants.length === 0) {
    logger.warn("no servable tenants — provision one first");
    return;
  }

  if (clearing) {
    for (const tenant of tenants) {
      if (!tenant.customDomain) continue;
      await updateCustomDomain(tenant.id, null);
      logger.info({ slug: tenant.slug, was: tenant.customDomain }, "custom domain detached");
    }
    return;
  }

  const ip = lanAddress();
  if (!ip) {
    throw new Error("no non-internal IPv4 address found — is this machine on a network?");
  }

  console.log(`\n  Attaching device-reachable hostnames on ${ip}\n`);

  for (const tenant of tenants) {
    const host = `${tenant.slug}.${ip}.sslip.io`;

    // A tenant may legitimately already own a real custom domain. Overwriting a hospital's own
    // hostname to make a phone work would be a bad trade, and `customDomain` holds only one.
    if (tenant.customDomain && !tenant.customDomain.endsWith(".sslip.io")) {
      logger.warn(
        { slug: tenant.slug, keeping: tenant.customDomain },
        "already has a real custom domain — left alone",
      );
      continue;
    }

    await updateCustomDomain(tenant.id, host);
    console.log(`    ${tenant.slug.padEnd(12)} http://${host}:${String(env.PORT)}`);
  }

  console.log(
    `\n  TENANT_BASE_DOMAIN stays "${env.TENANT_BASE_DOMAIN}" — the browser keeps working.` +
      `\n  Re-run this after changing network.\n`,
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await closeMaster();
  });
