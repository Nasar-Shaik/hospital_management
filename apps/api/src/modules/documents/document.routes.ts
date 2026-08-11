/**
 * Document routes (Module A7).
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Every edition can attach a document to a patient — an ID scan and a consent form are as basic
 * as registration itself. What varies is who MAY, which is the permission split below.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `file:upload` — attach a document. Front office and clinical staff who collect the paperwork.
 * `file:read`   — list a patient's documents and open one. Every role that reads the record.
 * `file:delete` — remove a document. A correction (wrong patient, wrong file); deliberately its
 *                 own permission, because deleting PHI is a heavier act than reading it.
 *
 * The upload route carries its OWN body parser at a higher limit than the app-wide 1 MB — a
 * base64 scan is a few MB — exactly like the report-upload route.
 */
import { Router, json } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds, respondsFile } from "../../middleware/responds.js";
import * as controller from "./document.controller.js";
import { documentDeletedAck, documentMeta } from "./document.contract.js";
import {
  uploadDocumentSchema,
  patientIdParamSchema,
  documentIdParamSchema,
} from "./document.schema.js";

export function documentRouter(): Router {
  const router = Router();

  router.post(
    "/patients/:patientId/documents",
    authenticate(),
    authorize(PERMISSIONS.FILE_UPLOAD),
    // Base64 documents exceed the app-wide 1 MB JSON limit; this route accepts more.
    json({ limit: "15mb" }),
    validate(patientIdParamSchema, "params"),
    validate(uploadDocumentSchema),
    responds(documentMeta, { status: 201 }),
    asyncHandler(controller.uploadDocument),
  );

  router.get(
    "/patients/:patientId/documents",
    authenticate(),
    authorize(PERMISSIONS.FILE_READ),
    validate(patientIdParamSchema, "params"),
    responds(documentMeta.array()),
    asyncHandler(controller.listPatientDocuments),
  );

  router.get(
    "/documents/:id/file",
    authenticate(),
    authorize(PERMISSIONS.FILE_READ),
    validate(documentIdParamSchema, "params"),
    respondsFile({
      // Whatever content type was stored at upload — `contentType` is a free string there, and
      // this route echoes it back. Naming PDF and images would document a rule nothing enforces.
      media: ["*/*"],
      description:
        "The stored file, inline, served with the content type it was uploaded with and a " +
        "`Content-Disposition` filename.",
    }),
    asyncHandler(controller.downloadDocument),
  );

  router.delete(
    "/documents/:id",
    authenticate(),
    authorize(PERMISSIONS.FILE_DELETE),
    validate(documentIdParamSchema, "params"),
    responds(documentDeletedAck),
    asyncHandler(controller.deleteDocument),
  );

  return router;
}
