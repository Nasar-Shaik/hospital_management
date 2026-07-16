/**
 * Billing module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * The charge ledger. Money is an integer number of PAISE, everywhere.
 *
 * ── THE DEPENDENCY ARROW POINTS INWARD, AND THAT IS THE DESIGN ──────────────
 * Billing depends on `encounters` (to validate a visit) and `tenants` (for the billing
 * policy). **Nothing clinical depends on billing.** The clinical modules announce what
 * happened through the outbox, and `billing.consumers.ts` decides what it costs — so a
 * bug in the tariff can never fail a registration, and a hospital that ignores the
 * billing screens still runs a clinic.
 *
 * `zero_tariff` (a government hospital) is ONE line in `postCharge`: the charge posts
 * at ₹0 and the invoice is still real. No code here reads `organizationType`.
 *
 * NOT a platform module: it prices consultations and beds (PLATFORM_STRATEGY §2).
 */
export { billingRouter } from "./billing.routes.js";
export { billingConsumers } from "./billing.consumers.js";

export {
  postCharge,
  reverseChargesFor,
  voidCharge,
  getCharges,
  getRunningBill,
  finalizeInvoice,
  recordPayment,
  listInvoices,
  listServices,
  getInvoice,
  type Charge,
  type Invoice,
  type ServiceItem,
  type PostChargeInput,
} from "./billing.service.js";

export {
  CHARGE_CATEGORIES,
  INVOICE_STATUSES,
  type ChargeCategory,
  type InvoiceStatus,
  type InvoiceLine,
} from "./billing.model.js";
