/**
 * MAR routes (Module D5 / nursing).
 *
 * ── GATED ON `module.clinical.nursing` ──────────────────────────────────────
 * The MAR is a nursing record; the editions that staff a ward carry the flag. A tenant without it
 * gets "not in your edition" rather than a permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`emr:read`)        — read the MAR. Everyone clinical: the doctor reviewing the chart and the
 *                            pharmacist reconciling both need to see what was actually given.
 * ADMINISTER (`mar:administer`) — chart a dose. The nurse's own act — its own permission, separate
 *                            from writing a ward note (`emr:write`), because giving a drug and
 *                            writing a line about it are different responsibilities.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./mar.controller.js";
import { recordAdministrationSchema, encounterIdParamSchema } from "./mar.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_NURSING } as const;

export function marRouter(): Router {
  const router = Router();

  router.get(
    "/encounters/:id/medication-administrations",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(encounterIdParamSchema, "params"),
    asyncHandler(controller.listAdministrations),
  );

  router.post(
    "/encounters/:id/medication-administrations",
    authenticate(),
    authorize(PERMISSIONS.MAR_ADMINISTER, FEATURE),
    validate(encounterIdParamSchema, "params"),
    validate(recordAdministrationSchema),
    asyncHandler(controller.recordAdministration),
  );

  return router;
}
