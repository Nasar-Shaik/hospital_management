/**
 * Medicine master + stock routes.
 *
 * ── GATED ON `module.pharmacy.full`, NOT ON `.dispensing` ────────────────────
 * The dispensing counter (Clinic Plus buys it alone) hands drugs over and keeps no
 * inventory. The MASTER — what the pharmacy stocks, and its stock ledger — is the department
 * behind the counter, and that is exactly what `PHARMACY_FULL` entitles. A clinic that bought
 * only dispensing gets a 403 here, which is correct: it has no shelf to manage.
 *
 * ── THE PERMISSION ──────────────────────────────────────────────────────────
 * `pharmacy:stock` throughout — the authority to maintain the shelf. NOT `pharmacy:dispense`:
 * the person who keeps the master and receives deliveries is doing inventory, not handing a
 * drug to a patient, and the two are separately grantable. Stock decrements from a dispense
 * are not a route here at all — they arrive as an event (`medicine.consumers.ts`).
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./medicine.controller.js";
import { medicine, stockChange, stockMovement, stockReportRow } from "./medicine.contract.js";
import {
  createMedicineSchema,
  updateMedicineSchema,
  receiveStockSchema,
  adjustStockSchema,
  listQuerySchema,
  idParamSchema,
} from "./medicine.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.PHARMACY_FULL } as const;

export function medicineRouter(): Router {
  const router = Router();

  router.get(
    "/medicines",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(listQuerySchema, "query"),
    responds(medicine.array()),
    asyncHandler(controller.list),
  );

  router.get(
    "/medicines/stock-report",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(listQuerySchema, "query"),
    responds(stockReportRow.array()),
    asyncHandler(controller.report),
  );

  router.get(
    "/medicines/:id",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(idParamSchema, "params"),
    responds(medicine),
    asyncHandler(controller.get),
  );

  router.get(
    "/medicines/:id/movements",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(idParamSchema, "params"),
    responds(stockMovement.array()),
    asyncHandler(controller.movements),
  );

  router.post(
    "/medicines",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(createMedicineSchema),
    responds(medicine, { status: 201 }),
    asyncHandler(controller.create),
  );

  router.patch(
    "/medicines/:id",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateMedicineSchema),
    responds(medicine),
    asyncHandler(controller.update),
  );

  router.post(
    "/medicines/:id/receive",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(idParamSchema, "params"),
    validate(receiveStockSchema),
    responds(stockChange, { status: 201 }),
    idempotent("Replays the stock receipt this key already booked in."),
    asyncHandler(controller.receive),
  );

  router.post(
    "/medicines/:id/adjust",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(idParamSchema, "params"),
    validate(adjustStockSchema),
    responds(stockChange, { status: 201 }),
    idempotent("Replays the stock adjustment this key already made."),
    asyncHandler(controller.adjust),
  );

  return router;
}
