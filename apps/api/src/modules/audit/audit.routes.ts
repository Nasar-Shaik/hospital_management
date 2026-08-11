/**
 * Audit routes (Doc 02 A5, Doc 09 §9).
 *
 * There is no POST, PATCH or DELETE here, and there never will be. The trail is
 * append-only: entries arrive from the audit plugin and from services, never from
 * a client. An HTTP surface that could write to the audit log would let an
 * attacker who reaches the API forge the record of their own visit.
 *
 * `audit:view` and `audit:export` are held by TENANT_ADMIN and by the dedicated
 * AUDITOR role — which holds those two permissions and almost nothing else, so a
 * compliance officer can inspect the hospital without being able to change it.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds, respondsFile } from "../../middleware/responds.js";
import * as controller from "./audit.controller.js";
import { auditEntry, auditIntegrity } from "./audit.contract.js";
import { exportAuditSchema, listAuditSchema } from "./audit.schema.js";

export function auditRouter(): Router {
  const router = Router();

  router.get(
    "/audit",
    authenticate(),
    authorize(PERMISSIONS.AUDIT_VIEW),
    validate(listAuditSchema, "query"),
    responds(auditEntry.array(), { meta: true }),
    asyncHandler(controller.listAudit),
  );

  // Separate permission from viewing: reading one entry on screen and walking out
  // with the hospital's whole trail in a spreadsheet are different acts, and the
  // second one is itself recorded (audit.service → `audit.exported`).
  router.get(
    "/audit/export",
    authenticate(),
    authorize(PERMISSIONS.AUDIT_EXPORT),
    validate(exportAuditSchema, "query"),
    respondsFile({
      media: ["text/csv"],
      description:
        "The audit trail as CSV, streamed as an attachment. The row count and whether the export " +
        "hit its cap travel in the `x-audit-rows` and `x-audit-truncated` headers — a truncated " +
        "export looks identical to a complete one in the body alone.",
    }),
    asyncHandler(controller.exportAudit),
  );

  router.get(
    "/audit/integrity",
    authenticate(),
    authorize(PERMISSIONS.AUDIT_VIEW),
    responds(auditIntegrity),
    asyncHandler(controller.checkIntegrity),
  );

  return router;
}
