/**
 * Report routes.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `order:perform` — upload a report. Held by the lab technician and the radiologist: the
 *                   people who actually run the test and produce the document. There is NO
 *                   verify/approve gate on a scanned report (see report.model.ts).
 * `emr:read`      — read a patient's report list and open a file. Every clinical role that
 *                   reads the chart, including the doctor the result comes back to.
 *
 * The upload route carries its OWN body parser at a higher limit than the app-wide 1 MB —
 * a base64 image is a few MB, and the global small limit is right for every other route.
 */
import { Router, json } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./report.controller.js";
import {
  orderIdParamSchema,
  patientIdParamSchema,
  reportIdParamSchema,
  uploadReportSchema,
} from "./report.schema.js";

export function reportRouter(): Router {
  const router = Router();

  router.post(
    "/orders/:id/reports",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM),
    // Base64 report files exceed the app-wide 1 MB JSON limit; this route accepts more.
    json({ limit: "15mb" }),
    validate(orderIdParamSchema, "params"),
    validate(uploadReportSchema),
    asyncHandler(controller.uploadReport),
  );

  router.get(
    "/patients/:patientId/reports",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(patientIdParamSchema, "params"),
    asyncHandler(controller.listPatientReports),
  );

  router.get(
    "/reports/:id/file",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(reportIdParamSchema, "params"),
    asyncHandler(controller.downloadReport),
  );

  return router;
}
