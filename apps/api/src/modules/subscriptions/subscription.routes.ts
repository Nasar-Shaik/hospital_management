/**
 * Subscription routes (Doc 02 A2).
 *
 * Reading your own subscription needs only `subscription:manage`, which a hospital
 * administrator holds — they must be able to see what they bought and how close to
 * the limits they are, without calling us.
 *
 * CHANGING the plan is a different matter. It is exposed here for the operator
 * console, and it is guarded by `plan:manage` — a permission whose scope is
 * `global` and which is granted to NO hospital role (TENANT_ADMIN holds 141 of the
 * 144 permissions; this is not one of them). A hospital cannot upgrade itself into
 * software it has not paid for.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./subscription.controller.js";
import { changePlanSchema, featureOverrideSchema } from "./subscription.schema.js";

export function subscriptionRouter(): Router {
  const router = Router();

  router.get(
    "/subscription",
    authenticate(),
    authorize(PERMISSIONS.SUBSCRIPTION_MANAGE),
    asyncHandler(controller.getSubscription),
  );

  router.get(
    "/plans",
    authenticate(),
    authorize(PERMISSIONS.SUBSCRIPTION_MANAGE),
    asyncHandler(controller.listPlans),
  );

  // Operator-only: `plan:manage` is granted to no hospital role by design.
  router.post(
    "/subscription/plan",
    authenticate(),
    authorize(PERMISSIONS.PLAN_MANAGE),
    validate(changePlanSchema),
    asyncHandler(controller.changePlan),
  );

  router.post(
    "/feature-flags",
    authenticate(),
    authorize(PERMISSIONS.FEATUREFLAG_MANAGE),
    validate(featureOverrideSchema),
    asyncHandler(controller.setFeatureOverride),
  );

  return router;
}
