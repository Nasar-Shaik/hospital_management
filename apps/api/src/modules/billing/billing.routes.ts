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
  listAllServicesQuerySchema,
  createServiceSchema,
  updateServiceSchema,
  postChargeSchema,
  recordPaymentSchema,
  voidChargeSchema,
} from "./billing.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function billingRouter(): Router {
  const router = Router();

  /**
   * PAID / UNPAID per order, for the worklist. Gated on `order:read` (NOT billing:read): a lab
   * technician must see whether the test in front of them has been paid for, and they hold that,
   * not the counter's permission. Returns a status flag only — no amounts, no bill.
   */
  router.get(
    "/billing/order-payments",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    asyncHandler(controller.orderPayments),
  );

  /**
   * PAID / UNPAID per encounter's consultation — reception's pay-before-queue gate. Gated on
   * `encounter:read`, which the receptionist holds: they must see whether the OP fee is settled
   * before offering "Add to queue". Status flag only — no amounts, no bill.
   */
  router.get(
    "/billing/consultation-payments",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    asyncHandler(controller.consultationPayments),
  );

  /**
   * Admitted-patient settle-from-advance, for the lab worklist. The READ (is the patient admitted,
   * what is their advance) needs only `order:read`; the ACTION (draw the advance to clear this test)
   * needs `order:perform` — the technician's own permission, because it draws down an advance the
   * desk already collected rather than taking new money.
   */
  router.get(
    "/billing/order-settlement",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    asyncHandler(controller.orderSettlement),
  );

  router.post(
    "/billing/orders/:id/settle-from-advance",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.settleOrderFromAdvance),
  );

  /** The price list — the counter's view. */
  router.get(
    "/services",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listServicesQuerySchema, "query"),
    asyncHandler(controller.listServices),
  );

  /**
   * The catalogue — the order pad's view. Same collection, NO prices, and gated on
   * `order:create` rather than `billing:read`.
   *
   * A doctor must be able to see that a chest X-ray exists here without being shown
   * what it costs while the patient is sitting in front of them. See the controller.
   */
  router.get(
    "/services/catalogue",
    authenticate(),
    authorize(PERMISSIONS.ORDER_CREATE, FEATURE),
    validate(listServicesQuerySchema, "query"),
    asyncHandler(controller.listCatalogue),
  );

  /**
   * The tariff MANAGER — the full price list, prices editable, retired entries shown.
   *
   * `tariff:manage`, not `billing:read`: this is where the hospital DEFINES what things cost,
   * not where a counter reads them. A separate route from `/services` because the two answer
   * different questions for different people — "what can I edit?" versus "what does this cost
   * right now?" — and only one of them may write.
   */
  router.get(
    "/tariff",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(listAllServicesQuerySchema, "query"),
    asyncHandler(controller.listAllServices),
  );

  router.post(
    "/tariff",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(createServiceSchema),
    asyncHandler(controller.createService),
  );

  router.patch(
    "/tariff/:id",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateServiceSchema),
    asyncHandler(controller.updateService),
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

  /**
   * The per-batch billing view: the pending (unbilled) charges plus every bill raised on the visit,
   * with payment state. What the reception desk collects against — finalize the pending batch, then
   * take money per bill.
   */
  router.get(
    "/encounters/:id/billing",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getEncounterBilling),
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
