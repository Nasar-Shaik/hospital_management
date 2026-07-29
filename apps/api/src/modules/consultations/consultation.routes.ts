/**
 * Consultation note routes (Module D3 / EMR depth).
 *
 * ── GATED ON `module.clinical.emr` ──────────────────────────────────────────
 * The structured note is the basic EMR — every edition that keeps a clinical record carries the
 * flag. A tenant without it (a pure diagnostic lab) gets "not in your edition" rather than a
 * permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`emr:read`)   — read the note. Everyone clinical, including the nurse and the pharmacist who
 *                       need the diagnosis to do their part.
 * WRITE (`emr:write`) — author it. The doctor (and, where they round, the nurse) — the same
 *                       permission that already guards the ward note and the visit summary.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./consultation.controller.js";
import { saveConsultationSchema, encounterIdParamSchema } from "./consultation.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_EMR_BASIC } as const;

export function consultationRouter(): Router {
  const router = Router();

  router.get(
    "/encounters/:id/consultation",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(encounterIdParamSchema, "params"),
    asyncHandler(controller.getConsultation),
  );

  router.put(
    "/encounters/:id/consultation",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(encounterIdParamSchema, "params"),
    validate(saveConsultationSchema),
    asyncHandler(controller.saveConsultation),
  );

  return router;
}
