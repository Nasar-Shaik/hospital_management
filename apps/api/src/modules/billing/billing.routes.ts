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
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./billing.controller.js";
import {
  billPreview,
  catalogueItem,
  charge,
  consultationPaymentStates,
  encounterBilling,
  invoice,
  pendingBill,
  invoiceSignatory,
  orderPaymentStates,
  orderSettlementInfos,
  orderSettlementResult,
  packageEnrollment,
  servicePackage,
  serviceItem,
} from "./billing.contract.js";
import {
  idParamSchema,
  listInvoicesQuerySchema,
  listPendingBillsQuerySchema,
  listServicesQuerySchema,
  listAllServicesQuerySchema,
  createServiceSchema,
  updateServiceSchema,
  postChargeSchema,
  recordPaymentSchema,
  applyDiscountSchema,
  recordRefundSchema,
  payerSplitSchema,
  createPackageSchema,
  updatePackageSchema,
  enrollPackageSchema,
  listPackagesQuerySchema,
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
    responds(orderPaymentStates),
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
    responds(consultationPaymentStates),
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
    responds(orderSettlementInfos),
    asyncHandler(controller.orderSettlement),
  );

  router.post(
    "/billing/orders/:id/settle-from-advance",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM, FEATURE),
    validate(idParamSchema, "params"),
    responds(orderSettlementResult),
    idempotent("Replays the settlement this key already made from the patient's advance."),
    asyncHandler(controller.settleOrderFromAdvance),
  );

  /** The price list — the counter's view. */
  router.get(
    "/services",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listServicesQuerySchema, "query"),
    responds(serviceItem.array()),
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
    responds(catalogueItem.array()),
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
    responds(serviceItem.array()),
    asyncHandler(controller.listAllServices),
  );

  router.post(
    "/tariff",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(createServiceSchema),
    responds(serviceItem, { status: 201 }),
    asyncHandler(controller.createService),
  );

  router.patch(
    "/tariff/:id",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateServiceSchema),
    responds(serviceItem),
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
    responds(billPreview),
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
    responds(encounterBilling),
    asyncHandler(controller.getEncounterBilling),
  );

  // Dated charges for a visit — the day-wise money on the IP treatment sheet.
  router.get(
    "/encounters/:id/charges",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(charge.array()),
    asyncHandler(controller.encounterCharges),
  );

  router.post(
    "/charges",
    authenticate(),
    authorize(PERMISSIONS.BILLING_CREATE, FEATURE),
    validate(postChargeSchema),
    responds(charge.optional(), { status: 201 }),
    idempotent("Replays the charge this key already posted to the bill."),
    asyncHandler(controller.postCharge),
  );

  /** Reversal is a void flag, never a delete — money that vanishes cannot be audited. */
  router.post(
    "/charges/:id/void",
    authenticate(),
    authorize(PERMISSIONS.BILLING_CREATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(voidChargeSchema),
    responds(charge),
    asyncHandler(controller.voidCharge),
  );

  router.post(
    "/encounters/:id/bill/finalize",
    authenticate(),
    authorize(PERMISSIONS.BILLING_FINALIZE, FEATURE),
    validate(idParamSchema, "params"),
    responds(invoice),
    idempotent("Replays the invoice this key already finalized, number and all."),
    asyncHandler(controller.finalizeBill),
  );

  /**
   * The cash counter's queue — visits with charges on no bill yet.
   *
   * `billing:read`, the same authority as the invoice list it sits beside, because it answers the
   * same question one step earlier: not "what has been billed" but "what has not been". Without
   * it, a cashier holding `billing:finalize` had no screen on which to use it, and a lab test
   * ordered by a doctor could not be paid for at the cash counter at all.
   */
  router.get(
    "/billing/pending",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listPendingBillsQuerySchema, "query"),
    responds(pendingBill.array(), { meta: true }),
    asyncHandler(controller.listPendingBills),
  );

  router.get(
    "/invoices",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listInvoicesQuerySchema, "query"),
    responds(invoice.array(), { meta: true }),
    asyncHandler(controller.listInvoices),
  );

  router.get(
    "/invoices/:id",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(invoice),
    asyncHandler(controller.getInvoice),
  );

  /**
   * The staff this bill records an act by, with their signatures — what the printed receipt puts
   * over "Received by". `billing:read`, the same authority that can already print the receipt;
   * it answers "who signed THIS bill", not "tell me about user X", so it opens no directory.
   */
  router.get(
    "/invoices/:id/signatories",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(invoiceSignatory.array()),
    asyncHandler(controller.getInvoiceSignatories),
  );

  router.post(
    "/invoices/:id/payments",
    authenticate(),
    authorize(PERMISSIONS.PAYMENT_COLLECT, FEATURE),
    validate(idParamSchema, "params"),
    validate(recordPaymentSchema),
    responds(invoice, { status: 201 }),
    idempotent("Replays the receipt for the payment this key already took."),
    asyncHandler(controller.recordPayment),
  );

  /**
   * Approved adjustments to a finalized bill. Deliberately NOT the cashier's own permissions —
   * the CASHIER role reads "Cannot discount or refund without approval", and these two routes are
   * where that line is enforced. `billing:discount` writes down the bill; `billing:refund` hands
   * money back. Both are a separate authority from posting a charge or taking a payment.
   */
  router.post(
    "/invoices/:id/discount",
    authenticate(),
    authorize(PERMISSIONS.BILLING_DISCOUNT, FEATURE),
    validate(idParamSchema, "params"),
    validate(applyDiscountSchema),
    responds(invoice),
    idempotent("Replays the bill as this key already discounted it."),
    asyncHandler(controller.applyDiscount),
  );

  router.post(
    "/invoices/:id/refund",
    authenticate(),
    authorize(PERMISSIONS.BILLING_REFUND, FEATURE),
    validate(idParamSchema, "params"),
    validate(recordRefundSchema),
    responds(invoice, { status: 201 }),
    idempotent("Replays the refund this key already paid out."),
    asyncHandler(controller.recordRefund),
  );

  /**
   * The payer split: how much of a finalized bill an insurer bears. `insurance:link` — the desk
   * that attaches insurance to a patient also decides the split, NOT the cashier. After it, the
   * counter collects only the patient's share; the insurer's is expected via an `insurance` payment.
   */
  router.post(
    "/invoices/:id/payer-split",
    authenticate(),
    authorize(PERMISSIONS.INSURANCE_LINK, FEATURE),
    validate(idParamSchema, "params"),
    validate(payerSplitSchema),
    responds(invoice),
    asyncHandler(controller.setPayerSplit),
  );

  /* ── care packages ───────────────────────────────────────────────────────
   * The catalogue is priced config the counter reads (`billing:read`) and the tariff manager
   * defines (`tariff:manage`) — the same split as `/services` vs `/tariff`. Enrolling a visit
   * posts money, so it is its own authority: `package:enroll`, the front desk / billing act. */
  router.get(
    "/packages",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(listPackagesQuerySchema, "query"),
    responds(servicePackage.array()),
    asyncHandler(controller.listPackages),
  );

  router.post(
    "/packages",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(createPackageSchema),
    responds(servicePackage, { status: 201 }),
    asyncHandler(controller.createPackage),
  );

  router.patch(
    "/packages/:id",
    authenticate(),
    authorize(PERMISSIONS.TARIFF_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updatePackageSchema),
    responds(servicePackage),
    asyncHandler(controller.updatePackage),
  );

  router.get(
    "/encounters/:id/package-enrollments",
    authenticate(),
    authorize(PERMISSIONS.BILLING_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(packageEnrollment.array()),
    asyncHandler(controller.listPackageEnrollments),
  );

  router.post(
    "/encounters/:id/package-enrollments",
    authenticate(),
    authorize(PERMISSIONS.PACKAGE_ENROLL, FEATURE),
    validate(idParamSchema, "params"),
    validate(enrollPackageSchema),
    responds(packageEnrollment, { status: 201 }),
    idempotent("Replays the package enrolment this key already created."),
    asyncHandler(controller.enrollPackage),
  );

  router.post(
    "/package-enrollments/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.PACKAGE_ENROLL, FEATURE),
    validate(idParamSchema, "params"),
    responds(packageEnrollment),
    asyncHandler(controller.cancelPackageEnrollment),
  );

  return router;
}
