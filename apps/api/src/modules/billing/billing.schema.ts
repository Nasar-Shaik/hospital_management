/**
 * Billing DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * Every amount is PAISE, and every one of them is `.int()`. A float that reaches the
 * ledger is money that cannot be reconciled, and the validator is the cheapest place
 * to stop it.
 */
import { z } from "@medicore/validation";
import { CHARGE_CATEGORIES, INVOICE_STATUSES } from "./billing.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
/** Paise. Non-negative integer, capped at ₹10,00,000 to catch a misplaced decimal. */
const paise = z.number().int().min(0).max(100_000_000);

export const postChargeSchema = z
  .object({
    encounterId: objectId,
    code: z.string().min(1).max(64),
    description: z.string().max(200).optional(),
    category: z.enum(CHARGE_CATEGORIES),
    quantity: z.number().int().min(1).max(1000).default(1),
    /** Overrides the tariff. The pharmacy knows the price of the batch it dispensed. */
    unitPrice: paise.optional(),
  })
  .strict();

export const voidChargeSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

/**
 * The idempotency key for a money-moving POST (Doc 03 §5.2, Constitution §7,
 * STATE_MACHINE_CATALOG §5). Same contract as `orders.requestId` and `dispenses.requestId`:
 * client-supplied, optional on the wire, and **the UI must always send one** — a cashier
 * double-clicking "Collect" must take the money once, not twice.
 *
 * Optional rather than required because making it mandatory is a breaking change to a shipped
 * endpoint; the lost-update guard below protects correctness even when no key is sent, so a
 * caller that omits it is never charged twice by a RACE — only by its own repeated submission.
 */
const requestId = z.string().trim().min(8).max(120).optional();

export const recordPaymentSchema = z
  .object({
    amount: paise.refine((v) => v > 0, "a payment of nothing is not a payment"),
    // `wallet` draws the money from the patient's advance rather than a drawer — the billing
    // service settles it atomically against the wallet (see recordPayment). The rest are the
    // ways money crosses the counter directly.
    method: z.enum(["cash", "card", "upi", "netbanking", "cheque", "insurance", "wallet"]),
    reference: z.string().max(120).optional(),
    requestId,
  })
  .strict();

export const applyDiscountSchema = z
  .object({
    amount: paise.refine((v) => v > 0, "a discount of nothing is not a discount"),
    reason: z.string().min(3).max(500),
  })
  .strict();

export const recordRefundSchema = z
  .object({
    amount: paise.refine((v) => v > 0, "a refund of nothing is not a refund"),
    method: z.enum(["cash", "card", "upi", "netbanking", "cheque", "insurance", "wallet"]),
    reason: z.string().min(3).max(500),
    requestId,
  })
  .strict();

export const payerSplitSchema = z
  .object({
    policyId: objectId,
    coveredAmount: paise,
  })
  .strict();

const packageCode = z.string().trim().min(1).max(64);
const includedCodes = z.array(z.string().trim().min(1).max(64)).max(200);

export const createPackageSchema = z
  .object({
    code: packageCode,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    price: paise.refine((v) => v > 0, "a package with no price is not a package"),
    includedCodes: includedCodes.default([]),
  })
  .strict();

export const updatePackageSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    price: paise.optional(),
    includedCodes: includedCodes.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const enrollPackageSchema = z.object({ packageCode }).strict();

export const listPackagesQuerySchema = z
  .object({ includeInactive: z.coerce.boolean().optional() })
  .strict();

export const listInvoicesQuerySchema = z
  .object({
    status: z.enum(INVOICE_STATUSES).optional(),
    patientId: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** The cash counter's queue. `q` matches a patient by name or UHID — who is at the window. */
export const listPendingBillsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const listServicesQuerySchema = z
  .object({ category: z.enum(CHARGE_CATEGORIES).optional() })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

/** The full tariff, retired entries included — the management read may filter by category. */
export const listAllServicesQuerySchema = z
  .object({ category: z.enum(CHARGE_CATEGORIES).optional() })
  .strict();

export const createServiceSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    category: z.enum(CHARGE_CATEGORIES),
    /** Paise — non-negative whole number. */
    price: z.number().int().min(0).max(1_000_000_000),
    /** Consultation only: days of free revisits. 0 (or absent) = every visit is charged. */
    followUpDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export const updateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    price: z.number().int().min(0).max(1_000_000_000).optional(),
    followUpDays: z.number().int().min(0).max(365).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export type PostChargeBody = z.infer<typeof postChargeSchema>;
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;
export type ApplyDiscountBody = z.infer<typeof applyDiscountSchema>;
export type RecordRefundBody = z.infer<typeof recordRefundSchema>;
export type PayerSplitBody = z.infer<typeof payerSplitSchema>;
export type CreatePackageBody = z.infer<typeof createPackageSchema>;
export type UpdatePackageBody = z.infer<typeof updatePackageSchema>;
export type EnrollPackageBody = z.infer<typeof enrollPackageSchema>;
export type ListPackagesQuery = z.infer<typeof listPackagesQuerySchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
export type ListPendingBillsQuery = z.infer<typeof listPendingBillsQuerySchema>;
export type CreateServiceBody = z.infer<typeof createServiceSchema>;
export type UpdateServiceBody = z.infer<typeof updateServiceSchema>;
