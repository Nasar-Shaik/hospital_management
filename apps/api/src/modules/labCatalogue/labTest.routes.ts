/**
 * Lab test catalogue routes (Module D6 / LIS depth).
 *
 * ── GATED ON `module.clinical.lis` ──────────────────────────────────────────
 * The test master is the laboratory information system's; an edition without a lab does not carry
 * the flag and gets "not in your edition" rather than a permission error no role edit could fix.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`order:read`)   — list tests and look one up. The BROAD lab read: the doctor ordering, the
 *                         technician entering a result and the pathologist verifying all hold it (it
 *                         is what shows them a worklist), and the catalogue is clinical config, not
 *                         PHI. So the read that feeds ordering + result entry is the worklist read.
 * WRITE (`lab:approve`) — define / edit a test. The pathologist owns the lab's master data — the same
 *                         authority that lets them verify a result — so the same permission guards it.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./labTest.controller.js";
import { labTest } from "./labTest.contract.js";
import {
  createLabTestSchema,
  updateLabTestSchema,
  listLabTestsQuerySchema,
  codeParamSchema,
  idParamSchema,
} from "./labTest.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_LIS } as const;

export function labCatalogueRouter(): Router {
  const router = Router();

  router.get(
    "/lab-tests",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    validate(listLabTestsQuerySchema, "query"),
    responds(labTest.array()),
    asyncHandler(controller.listTests),
  );

  router.get(
    "/lab-tests/:code",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    validate(codeParamSchema, "params"),
    responds(labTest),
    asyncHandler(controller.getTestByCode),
  );

  router.post(
    "/lab-tests",
    authenticate(),
    authorize(PERMISSIONS.LAB_APPROVE, FEATURE),
    validate(createLabTestSchema),
    responds(labTest, { status: 201 }),
    asyncHandler(controller.createTest),
  );

  // Different METHOD from the GET-by-code above, so the `:id` / `:code` paths do not collide.
  router.patch(
    "/lab-tests/:id",
    authenticate(),
    authorize(PERMISSIONS.LAB_APPROVE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateLabTestSchema),
    responds(labTest),
    asyncHandler(controller.updateTest),
  );

  return router;
}
