/**
 * Insurance routes — policies + claims (Doc 02 finance).
 *
 * ── GATED ON `module.finance.insurance` ─────────────────────────────────────
 * Only an edition that sells insurance handling carries the flag; a cash-only clinic gets "not in
 * your edition" (HMS-PLAN-002), which names the truth rather than a permission error no role edit
 * could fix.
 *
 * ── THE PERMISSION LADDER ────────────────────────────────────────────────────
 * READ + LINK (`insurance:link`)   — see a patient's policies and claims, and attach a policy. The
 *                            base act of recording who might pay; the front office does it at
 *                            registration.
 * FILE + DECIDE (`insurance:claim`) — file a claim and move it through submission and the payer's
 *                            decision (approved / partially / rejected). The billing/TPA desk.
 * SETTLE (`insurance:reconcile`)   — record that the money landed. Reconciliation is a DIFFERENT act
 *                            from adjudication — the person who closes the books is not always the
 *                            one who chased the approval — so settlement has its own permission.
 * (`insurance:preauth` is reserved for a dedicated pre-authorization request flow, not split out yet.)
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./insurance.controller.js";
import { insuranceClaim, insurancePolicy } from "./insurance.contract.js";
import {
  createPolicySchema,
  updatePolicySchema,
  createClaimSchema,
  transitionClaimSchema,
  settleClaimSchema,
  patientIdParamSchema,
  idParamSchema,
} from "./insurance.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.FINANCE_INSURANCE } as const;

export function insuranceRouter(): Router {
  const router = Router();

  /* ── Policies ── */
  router.get(
    "/patients/:patientId/insurance-policies",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_LINK, FEATURE),
    validate(patientIdParamSchema, "params"),
    responds(insurancePolicy.array()),
    asyncHandler(controller.listPolicies),
  );

  router.post(
    "/patients/:patientId/insurance-policies",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_LINK, FEATURE),
    validate(patientIdParamSchema, "params"),
    validate(createPolicySchema),
    responds(insurancePolicy, { status: 201 }),
    asyncHandler(controller.linkPolicy),
  );

  router.patch(
    "/insurance-policies/:id",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_LINK, FEATURE),
    validate(idParamSchema, "params"),
    validate(updatePolicySchema),
    responds(insurancePolicy),
    asyncHandler(controller.updatePolicy),
  );

  /* ── Claims ── */
  router.get(
    "/patients/:patientId/insurance-claims",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_LINK, FEATURE),
    validate(patientIdParamSchema, "params"),
    responds(insuranceClaim.array()),
    asyncHandler(controller.listClaims),
  );

  router.post(
    "/patients/:patientId/insurance-claims",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_CLAIM, FEATURE),
    validate(patientIdParamSchema, "params"),
    validate(createClaimSchema),
    responds(insuranceClaim, { status: 201 }),
    idempotent("Replays the claim this key already filed."),
    asyncHandler(controller.fileClaim),
  );

  router.post(
    "/insurance-claims/:id/transition",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_CLAIM, FEATURE),
    validate(idParamSchema, "params"),
    validate(transitionClaimSchema),
    responds(insuranceClaim),
    asyncHandler(controller.transitionClaim),
  );

  router.post(
    "/insurance-claims/:id/settle",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_RECONCILE, FEATURE),
    validate(idParamSchema, "params"),
    validate(settleClaimSchema),
    responds(insuranceClaim),
    idempotent("Replays the settlement this key already recorded."),
    asyncHandler(controller.settleClaim),
  );

  return router;
}
