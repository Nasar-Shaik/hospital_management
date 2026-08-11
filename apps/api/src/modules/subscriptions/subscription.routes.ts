/**
 * Subscription routes (Doc 02 A2).
 *
 * Reading your own subscription needs only `subscription:manage`, which a hospital
 * administrator holds — they must be able to see what they bought and how close to
 * the limits they are, without calling us.
 *
 * CHANGING the plan is a different matter. It is exposed here for the operator
 * console, and it is guarded by `plan:manage` — a SUPERADMIN permission whose
 * scope is `global` and which is granted to NO hospital role (TENANT_ADMIN holds
 * 139 of the 144 permissions; this is not one of them). A hospital cannot upgrade
 * itself into software it has not paid for.
 *
 * That sentence was once FALSE — `plan:manage` sat in the PLATFORM group,
 * TENANT_ADMIN inherited it, and the demo hospital upgraded itself to Enterprise.
 * The comment was there the whole time; nobody tested it. Every attempt is now
 * audited (`authz.denied`), so the next time the claim stops being true, the trail
 * says so.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./subscription.controller.js";
import { plan, subscriptionView } from "./subscription.contract.js";
import { changePlanSchema, featureOverrideSchema } from "./subscription.schema.js";

export function subscriptionRouter(): Router {
  const router = Router();

  router.get(
    "/subscription",
    authenticate(),
    authorize(PERMISSIONS.SUBSCRIPTION_MANAGE),
    responds(subscriptionView),
    asyncHandler(controller.getSubscription),
  );

  router.get(
    "/plans",
    authenticate(),
    authorize(PERMISSIONS.SUBSCRIPTION_MANAGE),
    responds(plan.array()),
    asyncHandler(controller.listPlans),
  );

  // Operator-only: `plan:manage` is granted to no hospital role by design.
  router.post(
    "/subscription/plan",
    authenticate(),
    authorize(PERMISSIONS.PLAN_MANAGE),
    validate(changePlanSchema),
    responds(subscriptionView),
    asyncHandler(controller.changePlan),
  );

  router.post(
    "/feature-flags",
    authenticate(),
    authorize(PERMISSIONS.FEATUREFLAG_MANAGE),
    validate(featureOverrideSchema),
    responds(subscriptionView),
    asyncHandler(controller.setFeatureOverride),
  );

  return router;
}
