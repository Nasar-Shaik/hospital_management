/**
 * Authentication middleware (Doc 04 §2.1 chain, ADR-0009).
 *
 * Runs AFTER `resolveTenant`, and that order is the whole point:
 *
 *   the HOST selects the database  →  the TOKEN proves who you are
 *
 * Two independent factors must agree. A valid token for Apollo, replayed against
 * `sunshine.paperlesstech.in`, is rejected with HMS-TEN-003 even though its
 * signature is perfectly good — because the connection already bound to
 * Sunshine's database, and a token from another hospital has no authority there.
 * Neither factor alone can select a tenant's data.
 *
 * Verification is stateless (no DB read) except for a Redis blocklist lookup for
 * logged-out tokens. The blocklist fails soft: if Redis is down, revocation
 * degrades to "effective within the access-token TTL" (≤15 min), the bound
 * ADR-0009 explicitly accepts. It never fails a request that would otherwise
 * succeed.
 */
import type { NextFunction, Request, Response } from "express";
import { getContext } from "../core/context/requestContext.js";
import { verifyToken } from "../core/crypto/jwt.js";
import { cacheGet, cacheKeys } from "../core/redis/redis.js";
import { tagMiddleware } from "../core/http/routeInventory.js";
import { SessionExpiredError, TenantMismatchError } from "../core/errors/appError.js";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

export function authenticate() {
  // Tagged so `routeInventory` can prove every /api/v1 route is behind it — see
  // core/http/routeInventory.ts. A route that forgot this is invisible in review.
  return tagMiddleware(
    (req: Request, _res: Response, next: NextFunction): void => {
      void (async () => {
        try {
          const token = bearerToken(req);
          if (!token) throw new SessionExpiredError({ reason: "missing bearer token" });

          let claims;
          try {
            claims = await verifyToken(token, "access");
          } catch {
            // Bad signature, wrong issuer, expired, or an MFA-challenge token used
            // as an access token — all indistinguishable to the caller on purpose.
            throw new SessionExpiredError();
          }

          const ctx = getContext();
          if (claims.tid !== ctx.tenantId) {
            throw new TenantMismatchError({ expected: ctx.tenantSlug, token: claims.tsl });
          }

          if (await cacheGet<number>(cacheKeys.revokedToken(claims.jti))) {
            throw new SessionExpiredError({ reason: "token revoked" });
          }

          // Enrich the request context in place — everything downstream in this
          // async tree (services, repositories, audit) sees the caller.
          ctx.userId = claims.sub;
          ctx.roles = claims.roles;
          ctx.branchIds = claims.branchIds;
          // So the audit trail can name a person rather than an ObjectId, without a
          // user lookup on every write (Doc 09 §9). Tokens minted before this claim
          // existed simply have no email — the trail falls back to the id, which is
          // still correct, just less readable.
          if (claims.eml) ctx.userEmail = claims.eml;

          req.auth = {
            userId: claims.sub,
            roles: claims.roles,
            branchIds: claims.branchIds,
            jti: claims.jti,
            expiresAt: claims.exp,
          };

          next();
        } catch (err) {
          next(err);
        }
      })();
    },
    { authenticates: true },
  );
}

/** The authenticated caller. Throws if used on a route that is not behind `authenticate`. */
export function requireAuth(req: Request): NonNullable<Request["auth"]> {
  if (!req.auth) {
    throw new Error("requireAuth() used on a route that is not behind authenticate()");
  }
  return req.auth;
}
