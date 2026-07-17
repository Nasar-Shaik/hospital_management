/**
 * Reporting routes — the audit/register suite.
 *
 * ── ONE PERMISSION, ONE FEATURE ─────────────────────────────────────────────
 * `report:view` throughout — reading a hospital-wide picture is a single authority, distinct from
 * the counter permissions that touch one record. Gated on `module.ops.opd`, the flag every
 * hospital that sees patients holds: a report over an empty pharmacy simply returns empty, so
 * there is no edition in which a hospital has patients but no reports to run.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS, type FeatureFlag } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./reporting.controller.js";
import { reportRangeSchema } from "./reporting.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;
// Discharge/mortality is an INPATIENT register — a clinic or diagnostic centre with no beds
// gets "not in your edition" rather than an empty table it could never populate.
const IPD_FEATURE = { feature: FEATURE_FLAGS.OPS_IPD } as const;

export function reportingRouter(): Router {
  const router = Router();

  const report = (
    path: string,
    handler: (typeof controller)[keyof typeof controller],
    feature: { feature: FeatureFlag } = FEATURE,
  ) =>
    router.get(
      path,
      authenticate(),
      authorize(PERMISSIONS.REPORT_VIEW, feature),
      validate(reportRangeSchema, "query"),
      asyncHandler(handler),
    );

  // "My day" — the caller's OWN activity. Authenticated but NOT gated on report:view: a doctor
  // seeing what they personally did is not the hospital-wide register the other reports are.
  router.get(
    "/reports/my-activity",
    authenticate(),
    validate(reportRangeSchema, "query"),
    asyncHandler(controller.myActivity),
  );

  report("/reports/pharmacy-stock", controller.stockRegister);
  report("/reports/patient-visits", controller.patientVisits);
  report("/reports/doctor-load", controller.doctorLoad);
  report("/reports/diagnostics", controller.diagnostics);
  report("/reports/collections", controller.collections);
  report("/reports/discharge-outcomes", controller.dischargeOutcomes, IPD_FEATURE);

  return router;
}
