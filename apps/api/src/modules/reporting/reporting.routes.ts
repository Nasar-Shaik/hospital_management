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
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./reporting.controller.js";
import { reportRangeSchema } from "./reporting.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function reportingRouter(): Router {
  const router = Router();

  const report = (path: string, handler: (typeof controller)[keyof typeof controller]) =>
    router.get(
      path,
      authenticate(),
      authorize(PERMISSIONS.REPORT_VIEW, FEATURE),
      validate(reportRangeSchema, "query"),
      asyncHandler(handler),
    );

  report("/reports/pharmacy-stock", controller.stockRegister);
  report("/reports/patient-visits", controller.patientVisits);
  report("/reports/doctor-load", controller.doctorLoad);
  report("/reports/diagnostics", controller.diagnostics);
  report("/reports/collections", controller.collections);

  return router;
}
