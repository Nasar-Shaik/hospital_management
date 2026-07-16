/**
 * Pharmacy routes.
 *
 * ── GATED ON `module.pharmacy.dispensing`, NOT ON `module.pharmacy.full` ────
 * Dispensing is the counter; `full` is the department behind it (stock, batches, expiry,
 * purchasing). Clinic Plus buys the counter alone — it hands out drugs against
 * prescriptions and keeps no inventory — so the routes gate on the NARROWER flag, the one
 * that is actually about the act being performed.
 *
 * Every edition that dispenses has this flag, including `PLAN_HOSPITAL`, which holds both
 * (see EDITIONS). Gating on `full` instead would have thrown a 403 at every clinic that
 * bought precisely the thing it was trying to do.
 *
 * ── THE PERMISSION ──────────────────────────────────────────────────────────
 * `pharmacy:dispense` — the authority to hand a drug to a patient against somebody else's
 * signature. NOT `prescription:*`: a pharmacist must never be able to write or alter the
 * prescription they are dispensing, and that separation is the whole reason the pharmacy
 * is a second pair of eyes rather than a hatch.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./pharmacy.controller.js";
import { dispenseSchema, idParamSchema } from "./pharmacy.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.PHARMACY_DISPENSING } as const;

export function pharmacyRouter(): Router {
  const router = Router();

  router.post(
    "/prescriptions/:id/dispense",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_DISPENSE, FEATURE),
    validate(idParamSchema, "params"),
    validate(dispenseSchema),
    asyncHandler(controller.dispense),
  );

  /**
   * The handover ledger. `emr:read` — this is a clinical record of what the patient was
   * actually given, and the ward nurse asking "did they collect it?" is not a pharmacist.
   */
  router.get(
    "/prescriptions/:id/dispenses",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.listDispenses),
  );

  return router;
}
