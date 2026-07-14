/**
 * Operator authentication (Doc 02 A1) — the control plane's front door.
 *
 * The mirror image of `authenticate`, and deliberately a SEPARATE middleware
 * rather than a flag on the existing one. The two populations must not share a
 * code path where a boolean decides whether tenant isolation applies; that
 * boolean is exactly the kind of thing that gets inverted in a refactor, and the
 * blast radius here is every hospital on the platform.
 *
 *   authenticate          → hospital user, inside ONE tenant   (token type "access")
 *   authenticatePlatform  → operator, across the fleet         (token type "platform")
 *
 * A token of the wrong type fails `verifyToken`, which checks the type as part of
 * verification. No route has to remember to check — the check is the verification.
 *
 * These routes are mounted OUTSIDE `resolveTenant`: an operator's request names no
 * hospital, so there is no tenant context, no tenant connection, and no way for
 * this middleware to accidentally hand one to a service.
 */
import type { NextFunction, Request, Response } from "express";
import { SessionExpiredError, InsufficientPermissionError } from "../core/errors/appError.js";
import { verifyToken } from "../core/crypto/jwt.js";
import { cacheGet, cacheKeys } from "../core/redis/redis.js";
import { findPlatformUserById } from "../modules/platform/platform.repository.js";
import type { PlatformRole } from "../modules/platform/platform.model.js";

function bearer(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

export function authenticatePlatform() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const token = bearer(req);
        if (!token) throw new SessionExpiredError({ reason: "no operator token" });

        /**
         * Type is checked INSIDE verification: a hospital user's access token
         * cannot be replayed here, whatever else it carries.
         *
         * The failure is translated to HMS-AUTH-002 rather than allowed to escape
         * as a raw Error. Presenting the wrong kind of token is an ordinary
         * authentication event — a stale tab, a copied header, someone probing —
         * and a 500 for it would be wrong twice over: it tells the caller our
         * internals hiccuped (they did not), and it pages an on-call engineer for
         * something that is working exactly as designed.
         */
        let claims;
        try {
          claims = await verifyToken(token, "platform");
        } catch {
          throw new SessionExpiredError({ reason: "not a valid operator token" });
        }

        if (await cacheGet<number>(cacheKeys.revokedToken(claims.jti))) {
          throw new SessionExpiredError({ reason: "token revoked" });
        }

        /**
         * Re-read the operator on EVERY request rather than trusting the token's
         * roles. A hospital user's roles are cached for their token's lifetime
         * (ADR-0010) and that is an accepted bound — but an operator account that
         * has just been disabled must lose access NOW, not in thirty minutes. This
         * population is tiny; the read costs nothing and it removes the one window
         * in which a fired operator still has the keys to every hospital.
         */
        const operator = await findPlatformUserById(claims.sub);
        if (!operator || operator.status !== "active") {
          throw new SessionExpiredError({ reason: "operator account is not active" });
        }

        req.operator = {
          id: operator.id,
          email: operator.email,
          roles: operator.roles,
          jti: claims.jti,
          expiresAt: claims.exp,
        };

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

export function requireOperator(req: Request): NonNullable<Request["operator"]> {
  if (!req.operator) {
    throw new Error("requireOperator called before authenticatePlatform — programming error");
  }
  return req.operator;
}

/**
 * Requires one of the given operator roles.
 *
 * SUPPORT is the default operator: they can see the fleet and impersonate for
 * support, but they cannot provision a hospital, suspend one, or change what it
 * pays. Those are SUPER_ADMIN. Most operator work is support work, so most
 * operators should hold the role that cannot re-price a customer by accident.
 */
export function requirePlatformRole(...allowed: PlatformRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const operator = requireOperator(req);
    if (!allowed.some((role) => operator.roles.includes(role))) {
      next(
        new InsufficientPermissionError({
          required: allowed.join(" or "),
          held: operator.roles,
        }),
      );
      return;
    }
    next();
  };
}
