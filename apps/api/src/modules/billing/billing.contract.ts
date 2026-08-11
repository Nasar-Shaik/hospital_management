/**
 * Billing response contracts. Every money field is PAISE, and integer — the contract says
 * `integer` so a client cannot quietly treat a rupee amount as a float.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import {
  CHARGE_CATEGORIES,
  CHARGE_SOURCES,
  INVOICE_STATUSES,
  PACKAGE_ENROLLMENT_STATUSES,
} from "./billing.model.js";
import type {
  Charge,
  Invoice,
  Package,
  PackageEnrollment,
  ServiceItem,
} from "./billing.repository.js";
import type {
  EncounterBilling,
  OrderSettlementResult,
  consultationPaymentStatus,
  getRunningBill,
  orderPaymentStatus,
  orderSettlementInfo as orderSettlementInfoFn,
} from "./billing.service.js";

const paise = z.number().int();
const chargeCategory = z.enum(CHARGE_CATEGORIES);

export const invoiceLine = contract(
  "InvoiceLine",
  z.object({
    code: z.string(),
    description: z.string(),
    category: chargeCategory,
    quantity: z.number(),
    listPrice: paise,
    amount: paise,
  }),
);

export const paymentEntry = contract(
  "PaymentEntry",
  z.object({
    amount: paise,
    method: z.string(),
    reference: z.string().optional(),
    at: z.string(),
    by: z.string().optional(),
    /** Idempotency key — a double-clicked "Collect" must take the money once. */
    requestId: z.string().optional(),
  }),
);

export const refundEntry = contract(
  "RefundEntry",
  z.object({
    amount: paise,
    method: z.string(),
    reason: z.string(),
    at: z.string(),
    by: z.string().optional(),
    requestId: z.string().optional(),
  }),
);

export const invoice = contract(
  "Invoice",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    number: z.string().optional(),
    status: z.enum(INVOICE_STATUSES),
    lines: z.array(invoiceLine),
    subtotal: paise,
    /** Paise off the subtotal — an approved write-down. `total = subtotal − discount`. */
    discount: paise,
    discountReason: z.string().optional(),
    total: paise,
    paid: paise,
    /** Paise an insurer is expected to bear (payer split). */
    coveredByInsurer: paise,
    insurerPolicyId: z.string().optional(),
    /** `total − coveredByInsurer` — the patient's own share, what the counter collects. */
    patientResponsibility: paise,
    payments: z.array(paymentEntry),
    refunds: z.array(refundEntry),
    refunded: paise,
    finalizedAt: z.string().optional(),
    createdAt: z.string(),
    /** Optimistic-concurrency counter (Doc 03 §5.2). */
    version: z.number(),
  }),
);
export type InvoiceProof = Proves<Matches<typeof invoice, Invoice>>;

export const charge = contract(
  "Charge",
  z.object({
    id: z.string(),
    encounterId: z.string(),
    patientId: z.string(),
    episodeId: z.string(),
    code: z.string(),
    description: z.string(),
    category: chargeCategory,
    quantity: z.number(),
    listPrice: paise,
    amount: paise,
    source: z.enum(CHARGE_SOURCES),
    sourceId: z.string().optional(),
    /** The branch this charge was raised in (ADR-0015) — the invoice inherits it. */
    branchId: z.string().optional(),
    /** Consultation charges: whose consultation it was. Drives the free-follow-up lookup. */
    doctorId: z.string().optional(),
    postedBy: z.string().optional(),
    postedAt: z.string(),
    invoiceId: z.string().optional(),
    voided: z.boolean().optional(),
    voidReason: z.string().optional(),
  }),
);
export type ChargeProof = Proves<Matches<typeof charge, Charge>>;

export const serviceItem = contract(
  "ServiceItem",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    category: chargeCategory,
    price: paise,
    /** Consultation only: days this fee buys free revisits to the same doctor. */
    followUpDays: z.number().optional(),
    active: z.boolean(),
  }),
);
export type ServiceItemProof = Proves<Matches<typeof serviceItem, ServiceItem>>;

/**
 * The bookable catalogue — what a clerk may add to a bill, WITHOUT the price.
 *
 * The controller strips `price` at the edge rather than letting the UI hide it: a price that
 * reaches the browser has been disclosed, whatever the screen chooses to render. So this is a
 * projection of `ServiceItem`, not `ServiceItem` itself, and the contract has to say so.
 */
type CatalogueRow = Pick<ServiceItem, "id" | "code" | "name" | "category">;
export const catalogueItem = contract(
  "CatalogueItem",
  z.object({ id: z.string(), code: z.string(), name: z.string(), category: chargeCategory }),
);
export type CatalogueItemProof = Proves<Matches<z.ZodArray<typeof catalogueItem>, CatalogueRow[]>>;

export const servicePackage = contract(
  "Package",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    description: z.string().optional(),
    price: paise,
    includedCodes: z.array(z.string()),
    active: z.boolean(),
  }),
);
export type PackageProof = Proves<Matches<typeof servicePackage, Package>>;

export const packageEnrollment = contract(
  "PackageEnrollment",
  z.object({
    id: z.string(),
    packageId: z.string(),
    packageCode: z.string(),
    packageName: z.string(),
    price: paise,
    includedCodes: z.array(z.string()),
    encounterId: z.string(),
    patientId: z.string(),
    status: z.enum(PACKAGE_ENROLLMENT_STATUSES),
    chargeId: z.string().optional(),
    enrolledAt: z.string(),
  }),
);
export type PackageEnrollmentProof = Proves<Matches<typeof packageEnrollment, PackageEnrollment>>;

/** The bill preview: what would be charged if the bill were raised now. */
export const billPreview = contract(
  "BillPreview",
  z.object({
    lines: z.array(invoiceLine),
    subtotal: paise,
    total: paise,
    invoice: invoice.optional(),
  }),
);
export type BillPreviewProof = Proves<Matches<typeof billPreview, Returns<typeof getRunningBill>>>;

export const encounterBilling = contract(
  "EncounterBilling",
  z.object({
    /** Charges not yet on any bill — the next bill to raise. */
    pending: z.object({ lines: z.array(invoiceLine), total: paise }),
    /** Every bill raised on this visit, oldest first. */
    invoices: z.array(invoice),
    totalBilled: paise,
    totalPaid: paise,
    /** Everything charged on the visit, billed or not. */
    grandTotal: paise,
    /** What the visit still owes — pending charges plus the unpaid part of issued bills. */
    outstanding: paise,
  }),
);
export type EncounterBillingProof = Proves<Matches<typeof encounterBilling, EncounterBilling>>;

const paymentState = z.enum(["paid", "unpaid", "unbilled", "free"]);

/** Keyed by order id — the queue screen colours a row from this. */
export const orderPaymentStates = contract("OrderPaymentStates", z.record(paymentState));
export type OrderPaymentStatesProof = Proves<
  Matches<typeof orderPaymentStates, Returns<typeof orderPaymentStatus>>
>;

/** Keyed by encounter id. */
export const consultationPaymentStates = contract(
  "ConsultationPaymentStates",
  z.record(paymentState),
);
export type ConsultationPaymentStatesProof = Proves<
  Matches<typeof consultationPaymentStates, Returns<typeof consultationPaymentStatus>>
>;

export const orderSettlementInfo = contract(
  "OrderSettlementInfo",
  z.object({
    /** The order's patient is on an open inpatient stay — the advance path applies. */
    admitted: z.boolean(),
    /** The patient's advance balance right now (may be negative once tests draw it down). */
    advanceBalance: paise,
    /** What this test's charge comes to — the amount the deduction will draw. */
    amount: paise,
  }),
);

/** Keyed by order id. */
export const orderSettlementInfos = contract("OrderSettlementInfos", z.record(orderSettlementInfo));
export type OrderSettlementInfosProof = Proves<
  Matches<typeof orderSettlementInfos, Returns<typeof orderSettlementInfoFn>>
>;

export const orderSettlementResult = contract(
  "OrderSettlementResult",
  z.object({
    orderId: z.string(),
    invoiceId: z.string(),
    /** The advance balance AFTER the deduction — may be negative for an admitted patient. */
    advanceBalance: paise,
  }),
);
export type OrderSettlementResultProof = Proves<
  Matches<typeof orderSettlementResult, OrderSettlementResult>
>;
