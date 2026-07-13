/**
 * Authorization middleware (ADR-0010, Doc 04 §2.1 chain).
 *
 * The full chain, and why the order is not negotiable:
 *
 *   resolveTenant   which hospital's database?      (Host header)
 *   authenticate    who are you?                    (JWT; its tenant must match)
 *   authorize       may you do this?                ← this file
 *     ├─ layer 1  entitlement — did this hospital BUY the capability?
 *     ├─ layer 2  permission  — does this USER hold `resource:action`?
 *     └─ layer 3  row scope   — may they see THIS row?  (enforced in repositories)
 *
 * Layer 1 before layer 2 is deliberate. A hospital that never bought the dialysis
 * module must get "not in your edition" (HMS-PLAN-002) — not "you lack permission"
 * (HMS-AUTH-005), which would send an administrator hunting through the role editor
 * for a permission that can never help them. The error tells the truth about which
 * wall you hit, and the two walls have different remedies: buy the module, or ask
 * an admin for the permission.
 *
 * Layer 3 cannot live here — a middleware sees a route, not a row. `authorize`
 * publishes the caller's scope into the request context, and repositories apply
 * it (see `scopeFilter`). A route that needs row scoping and forgets to use it is
 * the residual risk, which is precisely what the RBAC matrix suite tests.
 */
import type { NextFunction, Request, Response } from "express";
import type { FeatureFlag, PermissionDefinition } from "@medicore/permissions";
import { getContext } from "../core/context/requestContext.js";
import { AppError, InsufficientPermissionError } from "../core/errors/appError.js";
import { requireAuth } from "./authenticate.js";
import { getEffectivePermissions } from "../modules/rbac/index.js";
import { isFeatureEnabled } from "../modules/entitlements/index.js";

export interface AuthorizeOptions {
  /** Layer 1. Omit only when the capability is part of every edition (login, profile, …). */
  feature?: FeatureFlag;
}

/**
 * Requires a permission. Takes the DEFINITION, not a string — a typo in a string
 * literal is a silent hole that grants everyone access to a route nobody can
 * name; a typo in a constant does not compile (Guidelines Never-rule 7).
 *
 *     v1Router.use("/patients", authenticate(),
 *                  authorize(PERMISSIONS.PATIENT_READ, { feature: FEATURE_FLAGS.OPS_APPOINTMENTS }),
 *                  patientsRouter());
 */
export function authorize(permission: PermissionDefinition, options: AuthorizeOptions = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        const auth = requireAuth(req);
        const ctx = getContext();

        // ── layer 1: entitlement ──────────────────────────────────────────
        if (options.feature) {
          if (!(await isFeatureEnabled(ctx.tenantId, options.feature))) {
            throw new AppError("HMS-PLAN-002", 403, "Feature not in your edition", {
              feature: options.feature,
            });
          }
        }

        // ── layer 2: permission ───────────────────────────────────────────
        const held = await getEffectivePermissions(auth.userId);
        if (!held.has(permission.code)) {
          throw new InsufficientPermissionError({ required: permission.code });
        }

        // ── layer 3: publish the scope; repositories enforce it ───────────
        ctx.permissions = [...held];
        ctx.scope = {
          permission: permission.code,
          level: permission.scope ?? "tenant",
          branchIds: auth.branchIds,
          userId: auth.userId,
        };

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

/**
 * Requires only an entitlement, with no permission check — for routes any
 * authenticated user of an entitled hospital may reach (e.g. "is teleconsult
 * available?"). Rare by design: most routes need a permission too.
 */
export function requireFeature(feature: FeatureFlag) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        requireAuth(req);
        const ctx = getContext();
        if (!(await isFeatureEnabled(ctx.tenantId, feature))) {
          throw new AppError("HMS-PLAN-002", 403, "Feature not in your edition", { feature });
        }
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

/**
 * The row-scope filter for repositories — layer 3.
 *
 * Turns the caller's scope into a Mongo query fragment:
 *
 *   own    → only rows they own      ({ createdBy: me }, or a caller-supplied field)
 *   branch → only their branches     ({ branchId: { $in: [...] } })
 *   tenant → everything in the hospital (the tenantScope plugin already ensures this)
 *   global → unrestricted (platform operators only)
 *
 * A `branch`-scoped user with NO branches assigned is not "allowed everywhere" —
 * they are allowed nowhere, and this returns an impossible filter. Treating an
 * empty list as "no restriction" is the classic way branch scoping silently
 * becomes no scoping at all.
 */
export function scopeFilter(ownField = "createdBy"): Record<string, unknown> {
  const scope = getContext().scope;
  if (!scope) return {};

  switch (scope.level) {
    case "own":
      return { [ownField]: scope.userId };
    case "branch":
      if (scope.branchIds.length === 0) {
        // Fail closed. See above.
        return { branchId: { $in: [] } };
      }
      return { branchId: { $in: scope.branchIds } };
    case "tenant":
    case "global":
    default:
      return {};
  }
}
