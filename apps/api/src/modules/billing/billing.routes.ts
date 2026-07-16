/**
 * Billing routes (Doc 02 F-group).
 *
 * ── GATED ON `module.ops.opd`, NOT ON A BILLING FLAG ────────────────────────
 * Every hospital bills — including the government one, which bills ₹0 and needs the
 * invoice anyway for its own cost reporting. There is no edition in which a hospital
 * takes patients and has no bills, so a `module.billing` flag would be a switch nobody
 * would ever turn off.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `billing:read`     — reception, pharmacy, cashier, admin. Everyone who has to answer
 *                      "what do I owe?" at a counter.
 * `billing:create`   — post a manual charge.
 * `billing:finalize` — freeze the bill and assign its number. Deliberately separate:
 *                      finalizing is the moment the document becomes real.
 * `payment:collect`  — take money. A different act from producing the bill; the person
 *                      who prices the care should not also be the one pocketing it.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./billing.controller.js";
import {
  idParamSchema,
  listInvoicesQuerySchema,
  listServicesQuerySchema,
  postChargeSchema,
  recordPaymentSchema,
  voidChargeSchema,
} from "./billing.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function billingRouter(): Router {
  const router = Router();

  /** The price list. */
  router.get(
    "/services",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listServicesQuerySchema, "query"),
    asyncHandler(controller.listServices),
  );

  /**
   * The running bill for a visit — THE endpoint every login uses.
   *
   * `/encounters/:id/bill` rather than `/bills/:id` because the thing a human asks for
   * is "what does this visit cost?", and the visit is what they have in front of them.
   */
  router.get(
    "/encounters/:id/bill",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getBill),
  );

  router.post(
    "/charges",
    authenticate(),
    authorize(PERMISSIONS.BILLING_CREATE, FEATURE),
    validate(postChargeSchema),
    asyncHandler(controller.postCharge),
  );

  /** Reversal is a void flag, never a delete — money that vanishes cannot be audited. */
  router.post(
    "/charges/:id/void",
    authenticate(),
    authorize(PERMISSIONS.BILLING_CREATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(voidChargeSchema),
    asyncHandler(controller.voidCharge),
  );

  router.post(
    "/encounters/:id/bill/finalize",
    authenticate(),
    authorize(PERMISSIONS.BILLING_FINALIZE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.finalizeBill),
  );

  router.get(
    "/invoices",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listInvoicesQuerySchema, "query"),
    asyncHandler(controller.listInvoices),
  );

  router.get(
    "/invoices/:id",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getInvoice),
  );

  router.post(
    "/invoices/:id/payments",
    authenticate(),
    authorize(PERMISSIONS.PAYMENT_COLLECT, FEATURE),
    validate(idParamSchema, "params"),
    validate(recordPaymentSchema),
    asyncHandler(controller.recordPayment),
  );

  return router;
}
