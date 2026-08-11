/**
 * MRD routes (Module MRD) — clinical coding and the registers.
 *
 * ── GATED ON `module.support.mrd` ───────────────────────────────────────────
 * A records department is an edition feature; a small clinic that never codes gets "not in your
 * edition" rather than an empty page.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * MASTER (`mrd:manage`)         — define the ICD-10 code list. Reference data, admin config.
 * READ MASTER (`mrd:code`)      — look codes up while coding. The coder needs the picker.
 * CODE (`mrd:code`)             — assign codes to a visit. The doctor's act (they hold it).
 * REGISTER (`mrd:register:view`)— read the disease register. The auditor's / management's view.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./mrd.controller.js";
import { diseaseRegisterRow, encounterCoding, icdCode } from "./mrd.contract.js";
import {
  createIcdSchema,
  updateIcdSchema,
  listIcdQuerySchema,
  saveCodingSchema,
  idParamSchema,
  encounterParamSchema,
  registerQuerySchema,
} from "./mrd.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.SUPPORT_MRD } as const;

export function mrdRouter(): Router {
  const router = Router();

  // The coder searches the master while coding, so the READ is `mrd:code`, not `mrd:manage`.
  router.get(
    "/mrd/icd-codes",
    authenticate(),
    authorize(PERMISSIONS.MRD_CODE, FEATURE),
    validate(listIcdQuerySchema, "query"),
    responds(icdCode.array()),
    asyncHandler(controller.listIcd),
  );

  router.post(
    "/mrd/icd-codes",
    authenticate(),
    authorize(PERMISSIONS.MRD_MANAGE, FEATURE),
    validate(createIcdSchema),
    responds(icdCode, { status: 201 }),
    asyncHandler(controller.createIcd),
  );

  router.patch(
    "/mrd/icd-codes/:id",
    authenticate(),
    authorize(PERMISSIONS.MRD_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateIcdSchema),
    responds(icdCode),
    asyncHandler(controller.updateIcd),
  );

  router.get(
    "/mrd/codings/:encounterId",
    authenticate(),
    authorize(PERMISSIONS.MRD_CODE, FEATURE),
    validate(encounterParamSchema, "params"),
    responds(encounterCoding.nullable()),
    asyncHandler(controller.getCoding),
  );

  router.put(
    "/mrd/codings/:encounterId",
    authenticate(),
    authorize(PERMISSIONS.MRD_CODE, FEATURE),
    validate(encounterParamSchema, "params"),
    validate(saveCodingSchema),
    responds(encounterCoding),
    asyncHandler(controller.saveCoding),
  );

  router.get(
    "/mrd/disease-register",
    authenticate(),
    authorize(PERMISSIONS.MRD_REGISTER_VIEW, FEATURE),
    validate(registerQuerySchema, "query"),
    responds(diseaseRegisterRow.array()),
    asyncHandler(controller.diseaseRegister),
  );

  return router;
}
