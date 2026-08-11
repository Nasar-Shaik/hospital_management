/**
 * Platform routes (Doc 02 A1) — the operator console's API.
 *
 * ── MOUNTED OUTSIDE `resolveTenant`, WHICH IS THE WHOLE POINT ────────────────
 * Every route under `/api/v1` is resolved to exactly one hospital before any
 * handler runs. These are not: an operator's request names no hospital, so there
 * is no tenant context and no tenant connection for a service here to reach for
 * by accident. When the control plane DOES need to enter a hospital's data (to
 * count seats, to seed an admin), it opens that connection explicitly and
 * narrowly, in `platform.service`.
 *
 * ── WHO MAY DO WHAT ──────────────────────────────────────────────────────────
 * SUPPORT can SEE the fleet. SUPER_ADMIN can CHANGE it. The split is not
 * bureaucracy: provisioning, suspending and re-pricing are the three actions that
 * can take a hospital offline or cost it money, and the people doing day-to-day
 * support work should not be one mis-click away from any of them.
 *
 * ── WHAT IS NOT HERE, AND MUST NOT BE ────────────────────────────────────────
 * Any route that returns patient data. An operator manages the container — plan,
 * status, seats, administrators. The contents belong to the hospital. If support
 * genuinely must see a hospital's screen, that is impersonation: an ordinary
 * tenant token, bound by that hospital's own permissions, written into THAT
 * hospital's audit trail. Not a back door into PHI wearing an operator's badge.
 */
import { Router } from "express";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import {
  authenticatePlatform,
  requirePlatformRole,
} from "../../middleware/authenticatePlatform.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./platform.controller.js";
import {
  createdCredential,
  createHospitalResult,
  hospitalDetail,
  hospitalSummary,
  operatorIdentity,
  operatorLoggedOutAck,
  operatorPasswordChangedAck,
  operatorSession,
  platformAuditEntry,
  platformUser,
} from "./platform.contract.js";
import { plan, subscriptionView } from "../subscriptions/subscription.contract.js";
import {
  createHospitalSchema,
  createOperatorSchema,
  hospitalDomainSchema,
  hospitalLicenseSchema,
  hospitalLimitsSchema,
  hospitalPlanSchema,
  hospitalStatusSchema,
  issueAdminSchema,
  operatorLoginSchema,
  operatorPasswordSchema,
} from "./platform.schema.js";

export function platformRouter(): Router {
  const router = Router();

  /* ── unauthenticated ── */
  router.post(
    "/auth/login",
    validate(operatorLoginSchema),
    responds(operatorSession),
    asyncHandler(controller.login),
  );

  /* ── any authenticated operator ── */
  const auth = authenticatePlatform();

  router.post(
    "/auth/logout",

    auth,

    responds(operatorLoggedOutAck),

    asyncHandler(controller.logout),
  );
  router.get("/auth/me", auth, responds(operatorIdentity), controller.me);
  router.post(
    "/auth/change-password",
    auth,
    validate(operatorPasswordSchema),
    responds(operatorPasswordChangedAck),
    asyncHandler(controller.changePassword),
  );

  /* ── read the fleet: SUPPORT is enough ── */
  router.get(
    "/hospitals",
    auth,
    responds(hospitalSummary.array()),
    asyncHandler(controller.listHospitals),
  );
  router.get(
    "/hospitals/:id",
    auth,
    responds(hospitalDetail),
    asyncHandler(controller.getHospital),
  );
  router.get("/editions", auth, responds(plan.array()), asyncHandler(controller.listEditions));
  router.get(
    "/audit",
    auth,
    responds(platformAuditEntry.array()),
    asyncHandler(controller.operatorAudit),
  );

  /* ── change the fleet: SUPER_ADMIN only ── */
  const superAdmin = requirePlatformRole("SUPER_ADMIN");

  router.post(
    "/hospitals",
    auth,
    superAdmin,
    validate(createHospitalSchema),
    responds(createHospitalResult, { status: 201 }),
    asyncHandler(controller.createHospital),
  );

  // Takes a hospital OFFLINE — suspended tenants are refused at `resolveTenant`,
  // so their staff cannot log in at all. Not a button to leave lying around.
  router.post(
    "/hospitals/:id/status",
    auth,
    superAdmin,
    validate(hospitalStatusSchema),
    responds(hospitalSummary),
    asyncHandler(controller.setStatus),
  );

  router.post(
    "/hospitals/:id/plan",
    auth,
    superAdmin,
    validate(hospitalPlanSchema),
    responds(subscriptionView),
    asyncHandler(controller.setPlan),
  );

  // Supported branches (ADR-0015) — a sales control the tenant admin cannot raise.
  router.post(
    "/hospitals/:id/limits",
    auth,
    superAdmin,
    validate(hospitalLimitsSchema),
    responds(hospitalSummary),
    asyncHandler(controller.setLimits),
  );

  // Licence tenure (ADR-0016) — set / renew / extend. A renewal un-blocks an expired
  // hospital on its next request; no status change needed.
  router.post(
    "/hospitals/:id/license",
    auth,
    superAdmin,
    validate(hospitalLicenseSchema),
    responds(hospitalSummary),
    asyncHandler(controller.setLicense),
  );

  // Custom domain (ADR-0005) — attach / replace / detach a hostname for this hospital.
  router.post(
    "/hospitals/:id/domain",
    auth,
    superAdmin,
    validate(hospitalDomainSchema),
    responds(hospitalSummary),
    asyncHandler(controller.setDomain),
  );

  /**
   * Issues (or resets) a hospital's administrator credential — the highest-
   * privilege action the platform supports, and the "we're locked out" call every
   * SaaS vendor gets. It writes into the HOSPITAL's audit trail as well as ours,
   * so the customer can see us doing it.
   */
  router.post(
    "/hospitals/:id/admin",
    auth,
    superAdmin,
    validate(issueAdminSchema),
    responds(createdCredential),
    asyncHandler(controller.issueAdmin),
  );

  /* ── operator accounts ── */
  router.get(
    "/operators",
    auth,
    superAdmin,
    responds(platformUser.array()),
    asyncHandler(controller.listOperators),
  );
  router.post(
    "/operators",
    auth,
    superAdmin,
    validate(createOperatorSchema),
    responds(createdCredential, { status: 201 }),
    asyncHandler(controller.createOperator),
  );

  return router;
}
