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
import { tryRecordAudit } from "../core/audit/auditWriter.js";
import { requireAuth } from "./authenticate.js";
import { getEffectivePermissions, getEffectiveBranchScope } from "../modules/rbac/index.js";
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
          /**
           * A denial is audited (Doc 09 §9). One denial is a user clicking the
           * wrong thing; forty denials from one account in a minute is somebody
           * mapping the permission surface, and that pattern is invisible unless
           * the misses are recorded as well as the hits.
           *
           * Best-effort: the request is already being refused, and a failing audit
           * write must not turn a clean 403 into a confusing 500.
           */
          await tryRecordAudit({
            action: "authz.denied",
            category: "security",
            resource: "permission",
            resourceId: permission.code,
            outcome: "failure",
            meta: { required: permission.code, path: req.path, method: req.method },
          });

          throw new InsufficientPermissionError({ required: permission.code });
        }

        // ── layer 3: publish the scope; repositories enforce it ───────────
        //
        // The scope comes from the LIVE authorization bundle, not from the token.
        // Reading it from the token made row scope stale in precisely the case
        // that matters: a nurse moved off a ward, or restricted during an
        // investigation, kept seeing the old ward's patients until her token
        // expired. Permissions were live and scope was not — and the weaker half
        // silently decided what she could see.
        //
        // `allBranches` travels WITH `branchIds` and is never inferred from it
        // being empty — an empty list is also what a restricted binding looks like
        // after something goes wrong, and those two cases must not collapse into
        // one answer (rbac.model.ts).
        const { branchIds, allBranches } = await getEffectiveBranchScope(auth.userId);

        ctx.permissions = [...held];
        ctx.branchIds = branchIds;
        ctx.scope = {
          permission: permission.code,
          level: permission.scope ?? "tenant",
          branchIds,
          allBranches,
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
 *   branch → their branches, or everything if the binding is hospital-wide
 *   tenant → everything in the hospital (the tenantScope plugin already ensures this)
 *   global → unrestricted (platform operators only)
 *
 * ── THE `branch` CASE, WHICH IS THE SUBTLE ONE ───────────────────────────────
 * Two DIFFERENT situations both used to arrive here as an empty `branchIds`:
 *
 *   (a) "this person is not confined to any branch"  → should see everything
 *   (b) "this person is confined, to nothing"        → should see nothing
 *
 * They are opposites, and an empty array cannot tell them apart. This code used
 * to treat every empty list as (b) and fail closed — correct for (b), and the
 * reason it went unnoticed is that no `branch`-scoped resource existed. The moment
 * one did (patients, P2), every administrator's patient list came back empty:
 * everyone was case (a) and everyone was being answered as case (b).
 *
 * So the binding now states which it is (`branchScope`, rbac.model.ts) and the
 * answer is read, not guessed. Fail-closed remains exactly where it belongs — a
 * binding that SAYS it is branch-confined and names no branch still gets nothing,
 * so a cleared list can never silently become "the whole hospital".
 */
export function scopeFilter(ownField = "createdBy"): Record<string, unknown> {
  const scope = getContext().scope;
  if (!scope) return {};

  switch (scope.level) {
    case "own":
      return { [ownField]: scope.userId };
    case "branch":
      // (a) not confined to any branch — the hospital-wide binding.
      if (scope.allBranches) return {};
      // (b) confined, but to nothing. An impossible filter, deliberately.
      if (scope.branchIds.length === 0) return { branchId: { $in: [] } };
      return { branchId: { $in: scope.branchIds } };
    case "tenant":
    case "global":
    default:
      return {};
  }
}
