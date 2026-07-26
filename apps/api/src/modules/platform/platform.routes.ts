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
import * as controller from "./platform.controller.js";
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
  router.post("/auth/login", validate(operatorLoginSchema), asyncHandler(controller.login));

  /* ── any authenticated operator ── */
  const auth = authenticatePlatform();

  router.post("/auth/logout", auth, asyncHandler(controller.logout));
  router.get("/auth/me", auth, controller.me);
  router.post(
    "/auth/change-password",
    auth,
    validate(operatorPasswordSchema),
    asyncHandler(controller.changePassword),
  );

  /* ── read the fleet: SUPPORT is enough ── */
  router.get("/hospitals", auth, asyncHandler(controller.listHospitals));
  router.get("/hospitals/:id", auth, asyncHandler(controller.getHospital));
  router.get("/editions", auth, asyncHandler(controller.listEditions));
  router.get("/audit", auth, asyncHandler(controller.operatorAudit));

  /* ── change the fleet: SUPER_ADMIN only ── */
  const superAdmin = requirePlatformRole("SUPER_ADMIN");

  router.post(
    "/hospitals",
    auth,
    superAdmin,
    validate(createHospitalSchema),
    asyncHandler(controller.createHospital),
  );

  // Takes a hospital OFFLINE — suspended tenants are refused at `resolveTenant`,
  // so their staff cannot log in at all. Not a button to leave lying around.
  router.post(
    "/hospitals/:id/status",
    auth,
    superAdmin,
    validate(hospitalStatusSchema),
    asyncHandler(controller.setStatus),
  );

  router.post(
    "/hospitals/:id/plan",
    auth,
    superAdmin,
    validate(hospitalPlanSchema),
    asyncHandler(controller.setPlan),
  );

  // Supported branches (ADR-0015) — a sales control the tenant admin cannot raise.
  router.post(
    "/hospitals/:id/limits",
    auth,
    superAdmin,
    validate(hospitalLimitsSchema),
    asyncHandler(controller.setLimits),
  );

  // Licence tenure (ADR-0016) — set / renew / extend. A renewal un-blocks an expired
  // hospital on its next request; no status change needed.
  router.post(
    "/hospitals/:id/license",
    auth,
    superAdmin,
    validate(hospitalLicenseSchema),
    asyncHandler(controller.setLicense),
  );

  // Custom domain (ADR-0005) — attach / replace / detach a hostname for this hospital.
  router.post(
    "/hospitals/:id/domain",
    auth,
    superAdmin,
    validate(hospitalDomainSchema),
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
    asyncHandler(controller.issueAdmin),
  );

  /* ── operator accounts ── */
  router.get("/operators", auth, superAdmin, asyncHandler(controller.listOperators));
  router.post(
    "/operators",
    auth,
    superAdmin,
    validate(createOperatorSchema),
    asyncHandler(controller.createOperator),
  );

  return router;
}
