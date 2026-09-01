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
import { responds, respondsFile } from "../../middleware/responds.js";
import * as controller from "./report.controller.js";
import { reportMeta } from "./report.contract.js";
import {
  orderIdParamSchema,
  orderIdsQuerySchema,
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
    responds(reportMeta, { status: 201 }),
    asyncHandler(controller.uploadReport),
  );

  /**
   * The reports attached to a set of ORDERS — the lab worklist's read.
   *
   * Gated on `order:read` (NOT `emr:read`), by the same reasoning `/billing/order-payments` is
   * gated that way for the same screen: a technician must be able to see whether the test in front
   * of them already carries a file, and they hold `order:read`, not the chart's permission.
   *
   * `emr:read` would be the wrong grant to widen — it opens twenty-one routes across admissions,
   * wards, prescriptions, theatres, the MAR and medico-legal records, and a lab technician has no
   * business in any of them. This is metadata only; the BYTES stay behind `emr:read` below,
   * because knowing a report exists and reading it are different acts.
   */
  router.get(
    "/reports",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ),
    validate(orderIdsQuerySchema, "query"),
    responds(reportMeta.array()),
    asyncHandler(controller.reportsForOrders),
  );

  router.get(
    "/patients/:patientId/reports",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(patientIdParamSchema, "params"),
    responds(reportMeta.array()),
    asyncHandler(controller.listPatientReports),
  );

  router.get(
    "/reports/:id/file",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(reportIdParamSchema, "params"),
    respondsFile({
      // Whatever content type was stored at upload — `contentType` is a free string there, and
      // this route echoes it back. Naming PDF and images would document a rule nothing enforces.
      media: ["*/*"],
      description:
        "The stored file, inline, served with the content type it was uploaded with and a " +
        "`Content-Disposition` filename.",
    }),
    asyncHandler(controller.downloadReport),
  );

  return router;
}
