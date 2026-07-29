/**
 * Billing service (Doc 02 F-group).
 *
 * ── ONE CODE PATH SERVES A PRIVATE AND A GOVERNMENT HOSPITAL ────────────────
 * The ONLY difference is `policy.billingMode`, read from the tenant's preset. A
 * government hospital posts every charge at ₹0 and still produces a real invoice with
 * real line items; a private hospital posts the tariff. Nothing here reads
 * `organizationType` — there is a test that greps this source and fails if anyone ever
 * does (`organizations.test.ts`).
 *
 * ── A MISSING PRICE MUST NEVER BLOCK A CLINICAL ACTION ──────────────────────
 * If a doctor orders a test that is not in the tariff, the order still goes to the lab
 * and the charge posts at ₹0 with a loud log. The alternative — refusing the order —
 * means the hospital's price list can stop a patient being treated, and no biller's
 * data-entry backlog is worth that. The hospital fixes the tariff; the patient is
 * still seen.
 */
import { createLogger } from "@medicore/logger";
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { withTransaction } from "../../core/db/transaction.js";
import { getById as getTenant, policyOf } from "../tenants/index.js";
import { getEncounter } from "../encounters/index.js";
import { getBranch } from "../branches/index.js";
import {
  debitForInvoice as debitWalletForInvoice,
  getBalance as walletBalance,
} from "../wallet/index.js";
import * as repo from "./billing.repository.js";
import {
  INVOICE_TRANSITIONS,
  type ChargeCategory,
  type InvoiceLine,
  type InvoiceStatus,
  type PaymentEntry,
  type RefundEntry,
} from "./billing.model.js";

const logger = createLogger({ service: "billing" });

export type { Charge, Invoice, ServiceItem, BillReceipt } from "./billing.repository.js";

/** Issued bills with money taken in a period — the bill half of the receipts register. */
export function listReceipts(range: { from: Date; to: Date }): Promise<repo.BillReceipt[]> {
  return repo.receiptsBetween(range.from, range.to);
}

/* ── Free follow-up ("OP validity") ────────────────────────────────────────── */

/** A patient's live entitlement to see one doctor again without paying. */
export interface FollowUpEntitlement {
  /** The consultation charge that was paid and opened the window. */
  originChargeId: string;
  /** When that consultation was paid for. */
  since: Date;
  /** Last moment the free revisit applies — inclusive. */
  until: Date;
  /** The window the tariff grants, in days. Quoted on the charge description and the receipt. */
  days: number;
}

/**
 * Is this patient still inside a paid consultation's follow-up window with THIS doctor?
 *
 * ── THE RULE, AND WHY EACH CLAUSE IS THERE ──────────────────────────────────
 * A hospital that advertises "free follow-up within 15 days" means: you paid to see Dr Rao, so
 * seeing Dr Rao again about the same problem within 15 days costs nothing. Four conditions make
 * that honest, and each one closes a way the hospital would otherwise lose money or a patient
 * would be wrongly charged:
 *
 *   1. SAME DOCTOR. The fee bought that consultant's time and their duty to follow the case
 *      through. It does not buy a free consultation with a different specialist in another
 *      department, which is a new clinical problem and a new fee.
 *   2. THE ORIGINAL WAS ACTUALLY PAID. An unpaid consultation entitles nobody to a free one —
 *      otherwise "register, don't pay, come back tomorrow" is free care for ever.
 *   3. THE ORIGINAL WAS CHARGEABLE (`amount > 0`, enforced in the repository query). A waived
 *      follow-up must not itself grant another window, or one payment rolls forward indefinitely.
 *   4. INSIDE THE WINDOW, measured from when that consultation was POSTED.
 *
 * Returns undefined when the tariff grants no window (`followUpDays` absent or 0) — the safe
 * default, and what every hospital that never configures this keeps getting.
 */
export async function consultationFollowUp(input: {
  patientId: string;
  doctorId: string;
  /** The tariff code the consultation bills under — carries the window. */
  code: string;
  /** "Now" for the visit being registered; passed in so a redelivered event judges the same instant. */
  at: Date;
}): Promise<FollowUpEntitlement | undefined> {
  const service = await repo.findServiceByCode(input.code);
  const days = service?.followUpDays ?? 0;
  if (days <= 0) return undefined;

  const since = new Date(input.at.getTime() - days * 86_400_000);
  const candidates = await repo.paidConsultationsForDoctor({
    patientId: input.patientId,
    doctorId: input.doctorId,
    since,
  });
  if (candidates.length === 0) return undefined;

  // Only consultations that reached a PAID invoice count (clause 2). Billed-but-unpaid and
  // never-billed both fail, which is the same test reception's pay gate applies.
  const invoiceIds = [...new Set(candidates.map((c) => c.invoiceId).filter(Boolean))] as string[];
  const status = await repo.invoiceStatusByIds(invoiceIds);

  for (const charge of candidates) {
    if (!charge.invoiceId || status.get(charge.invoiceId) !== "paid") continue;
    const until = new Date(charge.postedAt.getTime() + days * 86_400_000);
    if (until.getTime() < input.at.getTime()) continue;
    return { originChargeId: charge.id, since: charge.postedAt, until, days };
  }
  return undefined;
}

export interface PostChargeInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  /** The tariff code. Resolved against `serviceItems` for the price. */
  code: string;
  /** Falls back to the tariff's name when the caller has nothing better. */
  description?: string;
  category: ChargeCategory;
  quantity?: number;
  source: "encounter" | "order" | "pharmacy" | "bed" | "manual";
  sourceId?: string;
  branchId?: string;
  /** Overrides the tariff — the pharmacy knows the price of the batch it dispensed. */
  unitPrice?: number;
  /** Consultation charges: whose consultation. Recorded so the follow-up rule can find it later. */
  doctorId?: string;
}

/**
 * Posts one charge against a visit.
 *
 * Idempotent on `sourceId`: the outbox is at-least-once, so the consumer that bills a
 * lab order WILL run twice, and the second run must not bill the patient again. The
 * arbiter is the unique index, not a prior read — the two deliveries can race.
 */
export async function postCharge(input: PostChargeInput): Promise<repo.Charge | undefined> {
  const ctx = getContext();
  const tenant = await getTenant(ctx.tenantId);
  const policy = policyOf(
    tenant ?? {
      id: ctx.tenantId,
      hospitalName: "",
      slug: ctx.tenantSlug,
      databaseName: "",
      status: "active",
    },
  );

  const service = await repo.findServiceByCode(input.code);
  if (!service && input.unitPrice === undefined) {
    logger.warn(
      { code: input.code, tenantId: ctx.tenantId },
      "no tariff entry — charge posted at 0 rather than blocking the clinical action",
    );
  }

  const quantity = input.quantity ?? 1;
  /** What this care is WORTH. Populated even when the patient owes nothing. */
  const listPrice = input.unitPrice ?? service?.price ?? 0;

  /**
   * ── THE WHOLE OF "GOVERNMENT HOSPITALS ARE FREE" ────────────────────────────
   * One line. The charge still posts, the line item still appears on the invoice, and
   * the state can still cost the encounter from `listPrice`. `zero_tariff` is a
   * TARIFF, not an off-switch — see BILLING_MODES.
   */
  const amount = policy.billingMode === "zero_tariff" ? 0 : listPrice * quantity;

  try {
    return await repo.postCharge({
      encounterId: input.encounterId,
      patientId: input.patientId,
      episodeId: input.episodeId,
      code: input.code,
      description: input.description ?? service?.name ?? input.code,
      category: input.category,
      quantity,
      listPrice,
      amount,
      source: input.source,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.branchId ? { branchId: input.branchId } : {}),
      ...(input.doctorId ? { doctorId: input.doctorId } : {}),
    });
  } catch (err) {
    if (!repo.isDuplicateKey(err)) throw err;
    // Already billed for this cause. A redelivered event, not a second blood test.
    logger.debug({ code: input.code, sourceId: input.sourceId }, "charge already posted — skipped");
    return undefined;
  }
}

/**
 * Un-bills everything one cause raised — the cancelled order.
 *
 * Returns how many charges were reversed, which is 0 on a redelivery and that is
 * correct, not an error.
 */
export const reverseChargesFor = repo.voidChargesBySource;

/* ── credit assessment: "can this patient afford this, from their advance?" ── */

export interface DrugCreditAssessment {
  /** The advance-budget rule applies only to ADMITTED (IP) patients. OP patients pay at the counter. */
  applies: boolean;
  /** Paise. What the drugs about to be handed over would cost (tariff-priced; 0 under zero-tariff). */
  cost: number;
  /** Paise. The patient's advance balance right now. */
  balance: number;
  /** Paise. How much the cost exceeds the advance — 0 when covered or the rule doesn't apply. */
  shortfall: number;
  /** True when the rule applies AND the dispense would push the advance below zero. */
  overBudget: boolean;
}

const NO_CREDIT_ISSUE: DrugCreditAssessment = {
  applies: false,
  cost: 0,
  balance: 0,
  shortfall: 0,
  overBudget: false,
};

/** Tariff-price a set of drug lines without posting anything — a pure read (zero under zero-tariff). */
async function quoteDrugs(lines: { drugCode: string; quantity: number }[]): Promise<number> {
  const ctx = getContext();
  const tenant = await getTenant(ctx.tenantId);
  const policy = policyOf(
    tenant ?? {
      id: ctx.tenantId,
      hospitalName: "",
      slug: ctx.tenantSlug,
      databaseName: "",
      status: "active",
    },
  );
  // Government / zero-tariff: the drugs are free, so there is never a shortfall to gate on.
  if (policy.billingMode === "zero_tariff") return 0;

  let total = 0;
  for (const line of lines) {
    const service = await repo.findServiceByCode(line.drugCode);
    total += (service?.price ?? 0) * line.quantity;
  }
  return total;
}

/**
 * Would handing these drugs over push an ADMITTED patient's advance below zero?
 *
 * Used by the pharmacy to decide whether a dispense needs a doctor's sign-off to proceed
 * on credit (the over-budget checkpoint). The rule is scoped to inpatients: a walk-in OP
 * patient pays at the counter and has no advance to overrun.
 *
 * Read-only and cheap. The CALLER treats any failure as "no issue" (fail-open) — a pricing
 * or wallet hiccup must never be able to hold a patient's medicine.
 */
export async function assessDrugCredit(input: {
  patientId: string;
  encounterId: string;
  lines: { drugCode: string; quantity: number }[];
}): Promise<DrugCreditAssessment> {
  const encounter = await getEncounter(input.encounterId);
  // OP (or unknown) — no advance-budget concept, so nothing to gate.
  if (encounter?.class !== "IP") return NO_CREDIT_ISSUE;

  const cost = await quoteDrugs(input.lines);
  const balance = await walletBalance(input.patientId);
  const shortfall = Math.max(0, cost - balance);
  return { applies: true, cost, balance, shortfall, overBudget: shortfall > 0 };
}

export const getCharges = repo.chargesForEncounter;
export const listServices = repo.listServices;
export const listInvoices = repo.listInvoices;
export const getInvoice = repo.findInvoiceById;

/** The collections register for a period — used by the reporting module. */
export const collectionsReport = repo.collectionsReport;

/* ── Tariff management (the price list a hospital edits) ────────────────────── */

export const listAllServices = repo.listAllServices;

/**
 * Adds a service to the tariff. The code is the key an order and a charge carry, so it is
 * unique per hospital (migration 0006's index); a clash comes back as a clear 409 rather than
 * a duplicate-key stack trace.
 */
export async function createServiceItem(input: repo.CreateServiceInput): Promise<repo.ServiceItem> {
  try {
    return await repo.createService({ ...input, code: input.code.toUpperCase() });
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That service code is already in the tariff", {
        code: input.code,
        hint: "codes are unique per hospital — edit the existing entry, or pick another code",
      });
    }
    throw err;
  }
}

export async function updateServiceItem(
  id: string,
  patch: repo.UpdateServiceInput,
): Promise<repo.ServiceItem> {
  const updated = await repo.updateService(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Service not found", { id });
  return updated;
}

export async function voidCharge(id: string, reason: string): Promise<repo.Charge> {
  const charge = await repo.voidCharge(id, reason);
  if (!charge) {
    throw new AppError("HMS-STATE-001", 422, "Charge not found, or already on a finalized bill", {
      id,
      hint: "reversing a finalized charge is a credit note, not a void",
    });
  }
  return charge;
}

/**
 * The running bill for a visit — assembled LIVE from the charge ledger.
 *
 * Deliberately not a stored document until it is finalized. A draft bill that is
 * stored has to be kept in step with every charge that lands after it, and it will
 * drift; a draft bill that is computed cannot drift. It is only frozen when somebody
 * hands it to a patient (`finalizeInvoice`).
 */
export async function getRunningBill(encounterId: string): Promise<{
  lines: InvoiceLine[];
  subtotal: number;
  total: number;
  invoice?: repo.Invoice;
}> {
  const existing = await repo.findInvoiceForEncounter(encounterId);
  if (existing && existing.status !== "draft") {
    // Finalized: the frozen document IS the bill. Never recompute it.
    return {
      lines: existing.lines,
      subtotal: existing.subtotal,
      total: existing.total,
      invoice: existing,
    };
  }

  const charges = await repo.chargesForEncounter(encounterId);
  const lines: InvoiceLine[] = charges.map((c) => ({
    code: c.code,
    description: c.description,
    category: c.category,
    quantity: c.quantity,
    listPrice: c.listPrice,
    amount: c.amount,
  }));

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  return { lines, subtotal, total: subtotal, ...(existing ? { invoice: existing } : {}) };
}

/**
 * The series an invoice belongs to (ADR-0015) — resolved from the branch its charges
 * were raised in. Branchless charges (a hospital that predates branches) resolve to the
 * empty descriptor, so numbering stays on the original tenant-wide series.
 */
async function invoiceBranchOf(branchId?: string): Promise<repo.InvoiceBranch> {
  if (!branchId) return {};
  const branch = await getBranch(branchId);
  return branch ? { branchId, branchCode: branch.code, isMain: branch.isMain } : { branchId };
}

/**
 * Freezes the bill and gives it a number.
 *
 * After this the lines cannot move: an invoice that can be edited once it is in a
 * patient's hand is not a document, it is a suggestion. The number comes from an
 * atomic counter, because two cashiers finalizing at the same instant must not both
 * be handed `INV-2026-0042`.
 */
export async function finalizeInvoice(encounterId: string): Promise<repo.Invoice> {
  const ctx = getContext();

  /**
   * ── ONE BILL PER BATCH OF CHARGES, NOT ONE PER VISIT ────────────────────────
   * Finalizing bills the charges NOT YET on any invoice — the consultation at registration, then
   * the tests once a doctor has ordered them, then the pharmacy — each into its OWN numbered,
   * frozen document. A charge that arrives after a bill is issued lands on the NEXT bill, never on
   * the frozen one (STATE_MACHINE_CATALOG §4). This is what lets a patient pay for the consult
   * before they see the doctor and for the tests afterwards, and it is why the lab's paid-before-run
   * check can turn green per test.
   */
  const unbilled = await repo.unbilledChargesForEncounter(encounterId);
  const first = unbilled[0];
  if (!first) {
    // Nothing new to bill. Idempotent — a double-click, or a re-finalize with no fresh charges,
    // hands back the most recent bill rather than raising an empty one or a stack trace.
    const invoices = await repo.invoicesForEncounter(encounterId);
    const latest = invoices[invoices.length - 1];
    if (latest) return latest;
    throw new AppError("HMS-STATE-001", 422, "Nothing to bill on this visit", { encounterId });
  }

  const lines: InvoiceLine[] = unbilled.map((c) => ({
    code: c.code,
    description: c.description,
    category: c.category,
    quantity: c.quantity,
    listPrice: c.listPrice,
    amount: c.amount,
  }));
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);

  const invoice = await repo.createInvoice({
    encounterId,
    patientId: first.patientId,
    episodeId: first.episodeId,
    lines,
    subtotal,
    total: subtotal,
    // The invoice belongs to the branch its charges were raised in (ADR-0015).
    ...(first.branchId ? { branchId: first.branchId } : {}),
  });

  const number = await repo.nextInvoiceNumber(await invoiceBranchOf(first.branchId));

  const finalized = await repo.updateInvoice(invoice.id, {
    number,
    status: "finalized",
    lines,
    subtotal,
    total: subtotal,
    finalizedAt: new Date(),
    ...(ctx.userId ? { finalizedBy: ctx.userId } : {}),
  });
  if (!finalized) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoice.id });

  // Only the charges we just billed — see the repository note on why this is by-id, not by-encounter.
  await repo.attachChargesToInvoiceByIds(
    unbilled.map((c) => c.id),
    invoice.id,
  );

  /**
   * A ₹0 bill is SETTLED the moment it is finalized. A government hospital must not
   * grow a pile of "unpaid" invoices that nobody will ever pay — that would make every
   * outstanding-balance report meaningless, which is the sort of thing that gets a
   * product blamed for a problem it invented.
   */
  if (finalized.total === 0) {
    const paid = await repo.updateInvoice(invoice.id, { status: "paid" });
    return paid ?? finalized;
  }

  return finalized;
}

export interface EncounterBilling {
  /** Charges not yet on any bill — the next bill to raise. */
  pending: { lines: InvoiceLine[]; total: number };
  /** Every bill raised on this visit, oldest first, each with its own paid/finalized status. */
  invoices: repo.Invoice[];
  /** Paise. Sum of all invoice totals. */
  totalBilled: number;
  /** Paise. Sum of all invoice payments. */
  totalPaid: number;
  /** Paise. Everything charged on the visit, billed or not. */
  grandTotal: number;
  /** Paise. What the visit still owes — pending charges plus the unpaid part of issued bills. */
  outstanding: number;
}

/**
 * The whole billing picture for a visit — the pending (unbilled) charges plus every bill raised,
 * with their payment state. This is what the reception desk collects against: finalize the pending
 * batch into a bill, then take the money on each bill. The itemised OPD-slip bill and the ward's
 * "this stay owes" are read off the same view, so no two screens disagree on what is owed.
 */
export async function getEncounterBilling(encounterId: string): Promise<EncounterBilling> {
  const [unbilled, invoices] = await Promise.all([
    repo.unbilledChargesForEncounter(encounterId),
    repo.invoicesForEncounter(encounterId),
  ]);

  const lines: InvoiceLine[] = unbilled.map((c) => ({
    code: c.code,
    description: c.description,
    category: c.category,
    quantity: c.quantity,
    listPrice: c.listPrice,
    amount: c.amount,
  }));
  const pendingTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const totalBilled = invoices.reduce((sum, i) => sum + i.total, 0);
  const totalPaid = invoices.reduce((sum, i) => sum + i.paid, 0);

  return {
    pending: { lines, total: pendingTotal },
    invoices,
    totalBilled,
    totalPaid,
    grandTotal: pendingTotal + totalBilled,
    outstanding: pendingTotal + (totalBilled - totalPaid),
  };
}

export interface RecordPaymentInput {
  amount: number;
  method: string;
  reference?: string;
}

/** Takes money. Partial payments are normal; overpayment is refused. */
export async function recordPayment(
  invoiceId: string,
  input: RecordPaymentInput,
): Promise<repo.Invoice> {
  const ctx = getContext();

  const invoice = await repo.findInvoiceById(invoiceId);
  if (!invoice) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
  if (invoice.status === "cancelled") {
    throw new AppError("HMS-STATE-001", 422, "Cannot pay a cancelled invoice", { id: invoiceId });
  }
  if (invoice.status === "draft") {
    // Taking money against a bill whose lines can still change is how a patient pays
    // for a test they were never given.
    throw new AppError("HMS-STATE-001", 422, "Finalize the bill before taking payment", {
      id: invoiceId,
    });
  }

  const paid = invoice.paid + input.amount;
  if (paid > invoice.total) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: [`payment exceeds the balance of ${String(invoice.total - invoice.paid)} paise`],
    });
  }

  const status: InvoiceStatus = paid >= invoice.total ? "paid" : "finalized";
  if (!INVOICE_TRANSITIONS[invoice.status].includes(status) && status !== invoice.status) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      from: invoice.status,
      to: status,
    });
  }

  const payment: PaymentEntry = {
    amount: input.amount,
    method: input.method,
    at: new Date(),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(ctx.userId ? { by: ctx.userId } : {}),
  };

  /**
   * ── SETTLING FROM THE PATIENT'S ADVANCE ─────────────────────────────────────
   * `method: "wallet"` draws the money from the advance the desk collected earlier (an OP or
   * admission advance). The wallet debit and the invoice payment are ONE transaction: the
   * patient is never debited for a payment that did not post, nor credited on a bill that was
   * not paid. An insufficient balance throws (422) and rolls the whole thing back — nothing is
   * half-done. A cash/card payment takes the ordinary single-document path below.
   */
  if (input.method === WALLET_METHOD) {
    const updated = await withTransaction(async (session) => {
      await debitWalletForInvoice(session, {
        patientId: invoice.patientId,
        amount: input.amount,
        invoiceId,
        ...(invoice.encounterId ? { encounterId: invoice.encounterId } : {}),
      });
      return repo.addPayment(invoiceId, payment, status, paid, session);
    });
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
    return updated;
  }

  const updated = await repo.addPayment(invoiceId, payment, status, paid);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });

  return updated;
}

export interface ApplyDiscountInput {
  amount: number;
  reason: string;
}

/**
 * Applies an approved discount to a FINALIZED bill — a supervisor's write-down, gated on
 * `billing:discount` (the cashier cannot self-approve; see the CASHIER role).
 *
 * ── WHY FINALIZED, NOT DRAFT ────────────────────────────────────────────────
 * `finalizeInvoice` recomputes `total = subtotal` from the frozen lines, so a discount set on a
 * draft would be wiped the moment the bill is finalized. The discount is therefore an adjustment
 * to the finalized total, NOT a line edit: the itemisation stays frozen and auditable, and the
 * concession is a separate, named figure — which is exactly why `discount` and `total` are
 * distinct fields on the invoice. A cancelled bill takes no discount; a fully-paid one has nothing
 * left to discount (a return of money is a refund, not a discount).
 */
export async function applyDiscount(
  invoiceId: string,
  input: ApplyDiscountInput,
): Promise<repo.Invoice> {
  const ctx = getContext();
  const invoice = await repo.findInvoiceById(invoiceId);
  if (!invoice) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
  if (invoice.status !== "finalized") {
    throw new AppError("HMS-STATE-001", 422, "Only a finalized, unpaid bill can be discounted", {
      id: invoiceId,
      status: invoice.status,
      hint: "finalize the bill first; a fully-paid bill needs a refund, not a discount",
    });
  }
  if (input.amount > invoice.subtotal) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: [
        `a discount of ${String(input.amount)} exceeds the bill of ${String(invoice.subtotal)} paise`,
      ],
    });
  }
  const total = invoice.subtotal - input.amount;
  // The discount cannot drop the bill below what has already been collected — that money is in the
  // drawer, and reducing the total under it would invent a refund the cashier never made.
  if (total < invoice.paid) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: [
        `the bill is already ${String(invoice.paid)} paise paid — refund the excess instead`,
      ],
    });
  }
  // If the write-down clears the balance, the bill is settled — the same rule payment follows.
  const status: InvoiceStatus = invoice.paid >= total ? "paid" : "finalized";
  const updated = await repo.updateInvoice(invoiceId, {
    discount: input.amount,
    total,
    status,
    discountReason: input.reason,
    ...(ctx.userId ? { discountBy: ctx.userId } : {}),
  });
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
  return updated;
}

export interface RecordRefundInput {
  amount: number;
  method: string;
  reason: string;
}

/**
 * Hands money back — an overpayment or a paid-for service that was cancelled. Gated on
 * `billing:refund` (again, not the cashier's own authority).
 *
 * A refund can never exceed the NET already collected (`paid − refunded`): the hospital cannot
 * return money it never took. It is recorded as its own entry with a reason, never as a deletion
 * of the original payment — both legs of the money stay on the record for the drawer and the audit.
 */
export async function recordRefund(
  invoiceId: string,
  input: RecordRefundInput,
): Promise<repo.Invoice> {
  const ctx = getContext();
  const invoice = await repo.findInvoiceById(invoiceId);
  if (!invoice) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });

  const netCollected = invoice.paid - invoice.refunded;
  if (input.amount > netCollected) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: [
        `a refund of ${String(input.amount)} exceeds the ${String(netCollected)} paise collected`,
      ],
    });
  }

  const refund: RefundEntry = {
    amount: input.amount,
    method: input.method,
    reason: input.reason,
    at: new Date(),
    ...(ctx.userId ? { by: ctx.userId } : {}),
  };
  const updated = await repo.addRefund(invoiceId, refund, invoice.refunded + input.amount);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
  return updated;
}

/** The payment method that draws from the patient's advance rather than a drawer. */
const WALLET_METHOD = "wallet";

/** Whether the work an order represents has been PAID for — shown on the lab/imaging worklist. */
export type OrderPaymentState = "paid" | "unpaid" | "unbilled" | "free";

/**
 * The payment state of each order, traced order → charge → invoice.
 *
 * `free` means the charge exists but is worth nothing — a zero-tariff government patient, who must
 * never be shown as "unpaid" and turned away. `unbilled` means no charge was ever raised (nothing to
 * pay yet). This is a STATUS, not the bill: it carries no amounts, so the worklist can show it to a
 * technician who holds `order:read` but not `billing:read`.
 */
export async function orderPaymentStatus(
  orderIds: string[],
): Promise<Record<string, OrderPaymentState>> {
  const charges = await repo.chargesForSources(orderIds);

  // One order can raise more than one charge; collapse to a single owed amount + any invoice.
  const bySource = new Map<string, { amount: number; invoiceId?: string }>();
  for (const c of charges) {
    const existing = bySource.get(c.sourceId);
    if (existing) {
      existing.amount += c.amount;
      existing.invoiceId = existing.invoiceId ?? c.invoiceId;
    } else {
      bySource.set(c.sourceId, {
        amount: c.amount,
        ...(c.invoiceId ? { invoiceId: c.invoiceId } : {}),
      });
    }
  }

  const invoiceIds = [
    ...new Set(
      [...bySource.values()].map((v) => v.invoiceId).filter((x): x is string => Boolean(x)),
    ),
  ];
  const invoiceStatus = await repo.invoiceStatusByIds(invoiceIds);

  const out: Record<string, OrderPaymentState> = {};
  for (const id of orderIds) {
    const c = bySource.get(id);
    if (!c) out[id] = "unbilled";
    else if (c.amount === 0) out[id] = "free";
    else if (!c.invoiceId) out[id] = "unpaid";
    else out[id] = invoiceStatus.get(c.invoiceId) === "paid" ? "paid" : "unpaid";
  }
  return out;
}

/** Whether the CONSULTATION (OP fee) on a visit has been paid — gates joining the doctor's queue. */
export type ConsultationPaymentState = "paid" | "unpaid" | "unbilled" | "free";

/**
 * The OP-fee payment state per encounter, traced consultation-charge → invoice — the reception
 * gate for "pay before you join the queue".
 *
 * `free` is the zero-tariff government patient: the consultation is worth ₹0, so there is nothing
 * to pay and they queue immediately — never shown as "unpaid" and turned away. `unbilled` means the
 * consultation charge has not posted yet (the `encounter.started` event is in flight). Like
 * `orderPaymentStatus` this is a STATUS with no amounts, so it is reachable with `encounter:read` —
 * the receptionist can see whether to route the patient to the cash counter.
 */
export async function consultationPaymentStatus(
  encounterIds: string[],
): Promise<Record<string, ConsultationPaymentState>> {
  const charges = await repo.consultationChargesForEncounters(encounterIds);

  // A visit's consultation may be more than one charge (fee + express surcharge); collapse them.
  const byEncounter = new Map<string, { amount: number; invoiceId?: string }>();
  for (const c of charges) {
    const existing = byEncounter.get(c.encounterId);
    if (existing) {
      existing.amount += c.amount;
      existing.invoiceId = existing.invoiceId ?? c.invoiceId;
    } else {
      byEncounter.set(c.encounterId, {
        amount: c.amount,
        ...(c.invoiceId ? { invoiceId: c.invoiceId } : {}),
      });
    }
  }

  const invoiceIds = [
    ...new Set(
      [...byEncounter.values()].map((v) => v.invoiceId).filter((x): x is string => Boolean(x)),
    ),
  ];
  const invoiceStatus = await repo.invoiceStatusByIds(invoiceIds);

  const out: Record<string, ConsultationPaymentState> = {};
  for (const id of encounterIds) {
    const c = byEncounter.get(id);
    if (!c) out[id] = "unbilled";
    else if (c.amount === 0) out[id] = "free";
    else if (!c.invoiceId) out[id] = "unpaid";
    else out[id] = invoiceStatus.get(c.invoiceId) === "paid" ? "paid" : "unpaid";
  }
  return out;
}

/* ── Admitted patients: settle a test from the advance (never wait for money) ── */

/** Bills a specific set of unbilled charges into their own finalized invoice; returns its id. */
async function billChargesToInvoice(charges: repo.Charge[]): Promise<string> {
  const ctx = getContext();
  const first = charges[0];
  if (!first) throw new AppError("HMS-STATE-001", 422, "Nothing to bill", {});

  const lines: InvoiceLine[] = charges.map((c) => ({
    code: c.code,
    description: c.description,
    category: c.category,
    quantity: c.quantity,
    listPrice: c.listPrice,
    amount: c.amount,
  }));
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);

  const invoice = await repo.createInvoice({
    encounterId: first.encounterId,
    patientId: first.patientId,
    episodeId: first.episodeId,
    lines,
    subtotal,
    total: subtotal,
    ...(first.branchId ? { branchId: first.branchId } : {}),
  });
  const number = await repo.nextInvoiceNumber(await invoiceBranchOf(first.branchId));
  const finalized = await repo.updateInvoice(invoice.id, {
    number,
    status: "finalized",
    lines,
    subtotal,
    total: subtotal,
    finalizedAt: new Date(),
    ...(ctx.userId ? { finalizedBy: ctx.userId } : {}),
  });
  if (!finalized) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoice.id });
  await repo.attachChargesToInvoiceByIds(
    charges.map((c) => c.id),
    invoice.id,
  );
  return invoice.id;
}

export interface OrderSettlementInfo {
  /** The order's patient is on an open inpatient stay — the advance path applies. */
  admitted: boolean;
  /** Paise. The patient's advance balance right now (may be negative once tests draw it down). */
  advanceBalance: number;
  /** Paise. What this test's charge comes to — the amount the deduction will draw. */
  amount: number;
}

/**
 * For the lab worklist: is each order's patient an admitted (IP) one, and if so what is their
 * advance balance and this test's amount? Reachable with `order:read` — a status/amount slice, so
 * the technician can see whether to proceed by drawing the advance, without the billing detail.
 */
export async function orderSettlementInfo(
  orderIds: string[],
): Promise<Record<string, OrderSettlementInfo>> {
  const charges = await repo.chargesForSources(orderIds);

  const byOrder = new Map<string, { amount: number; encounterId: string }>();
  for (const c of charges) {
    if (!c.sourceId) continue;
    const existing = byOrder.get(c.sourceId);
    if (existing) existing.amount += c.amount;
    else byOrder.set(c.sourceId, { amount: c.amount, encounterId: c.encounterId });
  }

  const encounterIds = [...new Set([...byOrder.values()].map((v) => v.encounterId))];
  const encById = new Map<string, { klass: string; patientId: string }>();
  await Promise.all(
    encounterIds.map(async (id) => {
      const enc = await getEncounter(id).catch(() => null);
      if (enc) encById.set(id, { klass: enc.class, patientId: enc.patientId });
    }),
  );

  const patientIds = [...new Set([...encById.values()].map((v) => v.patientId))];
  const balanceByPatient = new Map<string, number>();
  await Promise.all(
    patientIds.map(async (pid) => {
      balanceByPatient.set(pid, await walletBalance(pid));
    }),
  );

  const out: Record<string, OrderSettlementInfo> = {};
  for (const id of orderIds) {
    const c = byOrder.get(id);
    const enc = c ? encById.get(c.encounterId) : undefined;
    out[id] = {
      admitted: enc?.klass === "IP",
      advanceBalance: enc ? (balanceByPatient.get(enc.patientId) ?? 0) : 0,
      amount: c?.amount ?? 0,
    };
  }
  return out;
}

export interface OrderSettlementResult {
  orderId: string;
  invoiceId: string;
  /** Paise. The advance balance AFTER the deduction — may be negative for an admitted patient. */
  advanceBalance: number;
}

/**
 * Settles ONE test from the admitted patient's advance, so the lab never waits for money.
 *
 * The technician holds `order:perform`, not billing or wallet permissions — but this is not taking
 * new cash, it is drawing DOWN an advance the desk already collected, so authorising the person in
 * front of the patient to do it is right, and the ledger records who and when. The balance is
 * allowed to go NEGATIVE (the relatives settle the shortfall later); a report is never held. This
 * is IP-only: an OP test is refused here and must be paid at the counter.
 */
export async function settleOrderFromAdvance(orderId: string): Promise<OrderSettlementResult> {
  const charges = await repo.fullChargesForSource(orderId);
  const first = charges[0];
  if (!first) {
    throw new AppError("HMS-STATE-001", 422, "This test has no charge to settle from advance", {
      orderId,
    });
  }

  const encounter = await getEncounter(first.encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Visit not found", { encounterId: first.encounterId });
  }
  if (encounter.class !== "IP") {
    throw new AppError(
      "HMS-STATE-001",
      422,
      "Settling from the advance is for admitted (inpatient) patients — collect an OP test at the counter",
      { orderId, class: encounter.class },
    );
  }

  // Make sure this test's charges are on a bill of their own, then settle that bill from advance.
  const unbilled = charges.filter((c) => !c.invoiceId);
  const invoiceId =
    unbilled.length > 0
      ? await billChargesToInvoice(unbilled)
      : charges.find((c) => c.invoiceId)?.invoiceId;
  if (!invoiceId) {
    throw new AppError("HMS-STATE-001", 422, "This test has no bill to settle", { orderId });
  }

  const invoice = await repo.findInvoiceById(invoiceId);
  if (!invoice) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });

  const due = invoice.total - invoice.paid;
  if (due <= 0) {
    // Already settled — idempotent (a double-click, or reception billed and paid it first).
    return { orderId, invoiceId, advanceBalance: await walletBalance(invoice.patientId) };
  }

  const ctx = getContext();
  const advanceBalance = await withTransaction(async (session) => {
    const balance = await debitWalletForInvoice(session, {
      patientId: invoice.patientId,
      amount: due,
      invoiceId,
      encounterId: encounter.id,
      allowNegative: true,
    });
    const payment: PaymentEntry = {
      amount: due,
      method: WALLET_METHOD,
      at: new Date(),
      ...(ctx.userId ? { by: ctx.userId } : {}),
    };
    const updated = await repo.addPayment(invoiceId, payment, "paid", invoice.total, session);
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });
    return balance;
  });

  return { orderId, invoiceId, advanceBalance };
}
