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
import { getById as getTenant, policyOf } from "../tenants/index.js";
import * as repo from "./billing.repository.js";
import {
  INVOICE_TRANSITIONS,
  type ChargeCategory,
  type InvoiceLine,
  type InvoiceStatus,
} from "./billing.model.js";

const logger = createLogger({ service: "billing" });

export type { Charge, Invoice, ServiceItem } from "./billing.repository.js";

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
 * Freezes the bill and gives it a number.
 *
 * After this the lines cannot move: an invoice that can be edited once it is in a
 * patient's hand is not a document, it is a suggestion. The number comes from an
 * atomic counter, because two cashiers finalizing at the same instant must not both
 * be handed `INV-2026-0042`.
 */
export async function finalizeInvoice(encounterId: string): Promise<repo.Invoice> {
  const ctx = getContext();

  const existing = await repo.findInvoiceForEncounter(encounterId);
  if (existing && existing.status !== "draft") {
    // Already finalized. Hand it back rather than erroring — a cashier who clicks
    // twice wants the bill, not a stack trace.
    return existing;
  }

  const bill = await getRunningBill(encounterId);
  const charges = await repo.chargesForEncounter(encounterId);
  const first = charges[0];
  if (!first) {
    throw new AppError("HMS-STATE-001", 422, "Nothing to bill on this visit", { encounterId });
  }

  const invoice =
    existing ??
    (await repo.createInvoice({
      encounterId,
      patientId: first.patientId,
      episodeId: first.episodeId,
      lines: bill.lines,
      subtotal: bill.subtotal,
      total: bill.total,
    }));

  const number = await repo.nextInvoiceNumber();

  const finalized = await repo.updateInvoice(invoice.id, {
    number,
    status: "finalized",
    lines: bill.lines,
    subtotal: bill.subtotal,
    total: bill.total,
    finalizedAt: new Date(),
    ...(ctx.userId ? { finalizedBy: ctx.userId } : {}),
  });
  if (!finalized) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoice.id });

  await repo.attachChargesToInvoice(encounterId, invoice.id);

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

  const updated = await repo.addPayment(
    invoiceId,
    {
      amount: input.amount,
      method: input.method,
      at: new Date(),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(ctx.userId ? { by: ctx.userId } : {}),
    },
    status,
    paid,
  );
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Invoice not found", { id: invoiceId });

  return updated;
}

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
