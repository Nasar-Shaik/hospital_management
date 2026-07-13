/**
 * Tenant resolution middleware (Doc 04 §2.1 chain, §2.2.1 resolution flow).
 *
 *   Host → slug/custom-domain → registry (Redis-cached) → status gate →
 *   Connection Manager → AsyncLocalStorage context
 *
 * Runs BEFORE authentication: the host selects the database, and auth
 * (Phase 1B) then asserts the JWT's tenant claim matches it (HMS-TEN-003).
 * The host is a routing hint, never an authorization authority.
 */
import type { NextFunction, Request, Response } from "express";
import { getTenantConnection } from "../core/db/connectionManager.js";
import { runWithContext } from "../core/context/requestContext.js";
import { TenantNotFoundError, TenantSuspendedError } from "../core/errors/appError.js";
import { SERVABLE_TENANT_STATUSES } from "../modules/tenants/tenant.model.js";
import { findByCustomDomain, findBySlug } from "../modules/tenants/tenant.repository.js";
import type { TenantRegistryEntry } from "../modules/tenants/tenant.repository.js";
import { env } from "../config/env.js";

/** Strips port, lowercases. `apollo.paperlesstech.in:3000` → `apollo.paperlesstech.in`. */
export function normalizeHost(hostHeader: string | undefined): string {
  return (hostHeader ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Extracts the tenant slug when the host is a subdomain of the platform domain.
 * Returns undefined for the apex domain, `www`, or any non-platform host
 * (which is then treated as a candidate custom domain).
 */
export function slugFromHost(
  host: string,
  baseDomain = env.TENANT_BASE_DOMAIN,
): string | undefined {
  if (!host.endsWith(`.${baseDomain}`)) return undefined;
  const label = host.slice(0, -(baseDomain.length + 1));
  if (!label || label === "www" || label.includes(".")) return undefined;
  return label;
}

/** Registry lookup: subdomain first, then verified custom domain (Doc 04 §2.2.1 step 1–2). */
export async function resolveTenantFromHost(
  host: string,
): Promise<TenantRegistryEntry | undefined> {
  const slug = slugFromHost(host);
  if (slug) return findBySlug(slug);
  return host ? findByCustomDomain(host) : undefined;
}

/**
 * Express middleware. On success, the rest of the request runs inside an ALS
 * context carrying the tenant's own database connection.
 */
export function resolveTenant() {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const host = normalizeHost(req.headers.host);
        const tenant = await resolveTenantFromHost(host);

        if (!tenant) throw new TenantNotFoundError({ host });

        // Status gate — suspended/expired/terminated/purged never reach the app.
        if (!SERVABLE_TENANT_STATUSES.includes(tenant.status)) {
          throw new TenantSuspendedError({ host, status: tenant.status });
        }

        const connection = await getTenantConnection({
          id: tenant.id,
          databaseName: tenant.databaseName,
          ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
        });

        runWithContext(
          {
            traceId: req.traceId,
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            connection,
            // For the audit trail (Doc 09 §9). `req.ip` is the gateway's view of
            // the client because `trust proxy` is on — which is the honest value:
            // it is what we can actually attest to, not what the client claims.
            ...(req.ip ? { ip: req.ip } : {}),
            ...(req.get("user-agent") ? { userAgent: req.get("user-agent") } : {}),
          },
          next,
        );
      } catch (err) {
        next(err);
      }
    })();
  };
}
