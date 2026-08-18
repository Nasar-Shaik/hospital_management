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
import {
  medicine,
  medicineAvailability,
  medicineBatch,
  stockChange,
  stockMovement,
  stockReportRow,
} from "./medicine.contract.js";
import {
  createMedicineSchema,
  updateMedicineSchema,
  receiveStockSchema,
  adjustStockSchema,
  listQuerySchema,
  idParamSchema,
  availabilityQuerySchema,
  codeParamSchema,
} from "./medicine.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.PHARMACY_FULL } as const;

export function medicineRouter(): Router {
  const router = Router();

  /**
   * ── AVAILABILITY IS THE PRESCRIBER'S QUESTION, SO IT IS THE PRESCRIBER'S PERMISSION ──
   * `prescription:create`, not `pharmacy:stock`. A doctor asking "can my patient get this here?"
   * is not doing inventory, and gating it on the pharmacy permission would have meant either no
   * doctor ever sees availability, or every doctor is granted the authority to receive deliveries
   * and write stock off — which is the "broad permission to make a screen work" mistake this
   * product has made before.
   *
   * The answer is deliberately narrow to match: a code and a number of units. No cost, no
   * reorder level, no ledger, no batch numbers. A prescriber learns whether the drug is there,
   * not what the hospital paid for it.
   *
   * And it is NOT gated on `module.pharmacy.full` like the rest of this file. A clinic that
   * bought only the dispensing counter still has drugs behind it and a doctor who benefits from
   * knowing so; the answer simply falls back to the master's running total. Gating it would make
   * the prescribing screen worse for the smallest customers, who are the ones who most often
   * hand the patient a chit for the shop next door.
   */
  router.get(
    "/medicines/availability",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_CREATE),
    validate(availabilityQuerySchema, "query"),
    responds(medicineAvailability.array()),
    asyncHandler(controller.availability),
  );

  router.get(
    "/medicines",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(listQuerySchema, "query"),
    responds(medicine.array()),
    asyncHandler(controller.list),
  );

  /**
   * The lots of one drug. `pharmacy:stock` — this is the shelf, and it deliberately INCLUDES
   * expired lots: somebody has to pull them and write them off, and a screen that hides expired
   * stock guarantees it stays on the shelf.
   */
  router.get(
    "/medicines/:code/batches",
    authenticate(),
    authorize(PERMISSIONS.PHARMACY_STOCK, FEATURE),
    validate(codeParamSchema, "params"),
    responds(medicineBatch.array()),
    asyncHandler(controller.shelf),
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
