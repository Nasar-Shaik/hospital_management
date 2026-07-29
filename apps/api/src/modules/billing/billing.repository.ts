/**
 * Billing repository — the ONLY code that queries `serviceItems`, `charges` and
 * `invoices` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getChargeModel,
  getInvoiceModel,
  getServiceItemModel,
  type ChargeCategory,
  type ChargeDoc,
  type ChargeSource,
  type InvoiceDoc,
  type InvoiceLine,
  type InvoiceStatus,
  type PaymentEntry,
  type RefundEntry,
  type ServiceItemDoc,
} from "./billing.model.js";

export { isDuplicateKey };

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: ChargeCategory;
  price: number;
  /** Consultation only: days this fee buys free revisits to the same doctor. Absent/0 = none. */
  followUpDays?: number;
  active: boolean;
}

export interface Charge {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  code: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  listPrice: number;
  amount: number;
  source: ChargeSource;
  sourceId?: string;
  /** The branch this charge was raised in (ADR-0015) — the invoice covering it inherits it. */
  branchId?: string;
  /** Consultation charges: whose consultation it was. Drives the free-follow-up lookup. */
  doctorId?: string;
  postedBy?: string;
  postedAt: Date;
  invoiceId?: string;
  voided?: boolean;
  voidReason?: string;
}

export interface Invoice {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  number?: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  discountReason?: string;
  total: number;
  paid: number;
  /** Paise the insurer is expected to bear. */
  coveredByInsurer: number;
  insurerPolicyId?: string;
  /** Derived: `total − coveredByInsurer`. What the patient's own money must cover. */
  patientResponsibility: number;
  payments: PaymentEntry[];
  refunds: RefundEntry[];
  refunded: number;
  finalizedAt?: Date;
  createdAt: Date;
}

function toServiceItem(d: ServiceItemDoc): ServiceItem {
  return {
    id: d._id.toString(),
    code: d.code,
    name: d.name,
    category: d.category,
    price: d.price,
    ...(typeof d.followUpDays === "number" ? { followUpDays: d.followUpDays } : {}),
    active: d.active,
  };
}

function toCharge(d: ChargeDoc): Charge {
  return {
    id: d._id.toString(),
    encounterId: d.encounterId.toString(),
    patientId: d.patientId.toString(),
    episodeId: d.episodeId.toString(),
    code: d.code,
    description: d.description,
    category: d.category,
    quantity: d.quantity,
    listPrice: d.listPrice,
    amount: d.amount,
    source: d.source,
    postedAt: d.postedAt,
    ...(d.sourceId ? { sourceId: d.sourceId } : {}),
    ...(d.branchId ? { branchId: d.branchId } : {}),
    ...(d.doctorId ? { doctorId: d.doctorId } : {}),
    ...(d.postedBy ? { postedBy: d.postedBy } : {}),
    ...(d.invoiceId ? { invoiceId: d.invoiceId.toString() } : {}),
    ...(d.voided ? { voided: true } : {}),
    ...(d.voidReason ? { voidReason: d.voidReason } : {}),
  };
}

function toInvoice(d: InvoiceDoc): Invoice {
  return {
    id: d._id.toString(),
    encounterId: d.encounterId.toString(),
    patientId: d.patientId.toString(),
    episodeId: d.episodeId.toString(),
    status: d.status,
    lines: d.lines ?? [],
    subtotal: d.subtotal,
    discount: d.discount,
    total: d.total,
    paid: d.paid,
    coveredByInsurer: d.coveredByInsurer ?? 0,
    patientResponsibility: d.total - (d.coveredByInsurer ?? 0),
    payments: d.payments ?? [],
    refunds: d.refunds ?? [],
    refunded: d.refunded ?? 0,
    createdAt: d.createdAt,
    ...(d.insurerPolicyId ? { insurerPolicyId: d.insurerPolicyId } : {}),
    ...(d.discountReason ? { discountReason: d.discountReason } : {}),
    ...(d.number ? { number: d.number } : {}),
    ...(d.finalizedAt ? { finalizedAt: d.finalizedAt } : {}),
  };
}

/* ── Tariff ────────────────────────────────────────────────────────────────── */

export async function findServiceByCode(code: string): Promise<ServiceItem | undefined> {
  const doc = await getServiceItemModel(getTenantDb())
    .findOne({ code: code.toUpperCase(), active: true })
    .lean<ServiceItemDoc>();
  return doc ? toServiceItem(doc) : undefined;
}

export async function listServices(category?: ChargeCategory): Promise<ServiceItem[]> {
  const docs = await getServiceItemModel(getTenantDb())
    .find({ active: true, ...(category ? { category } : {}) })
    .sort({ category: 1, name: 1 })
    .lean<ServiceItemDoc[]>();
  return docs.map(toServiceItem);
}

/**
 * The FULL tariff, retired entries included — the management view. `listServices` above is the
 * clinical read (active only, price stripped at the controller); this one carries the price and
 * the inactive rows, because managing a price list means seeing what you have turned off.
 */
export async function listAllServices(category?: ChargeCategory): Promise<ServiceItem[]> {
  const docs = await getServiceItemModel(getTenantDb())
    .find({ ...(category ? { category } : {}) })
    .sort({ category: 1, name: 1 })
    .lean<ServiceItemDoc[]>();
  return docs.map(toServiceItem);
}

export async function findServiceById(id: string): Promise<ServiceItem | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getServiceItemModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<ServiceItemDoc>();
  return doc ? toServiceItem(doc) : undefined;
}

export interface CreateServiceInput {
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. */
  price: number;
  /** Consultation only: days of free revisits this fee buys. */
  followUpDays?: number;
}

export async function createService(input: CreateServiceInput): Promise<ServiceItem> {
  const ctx = getContext();
  const doc = await getServiceItemModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code,
    name: input.name,
    category: input.category,
    price: input.price,
    ...(input.followUpDays !== undefined ? { followUpDays: input.followUpDays } : {}),
    active: true,
  });
  return toServiceItem(doc.toObject() as ServiceItemDoc);
}

/** Editable fields of a tariff entry. NOT `code` or `category` — those define what it IS. */
export interface UpdateServiceInput {
  name?: string;
  price?: number;
  followUpDays?: number;
  active?: boolean;
}

export async function updateService(
  id: string,
  patch: UpdateServiceInput,
): Promise<ServiceItem | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getServiceItemModel(getTenantDb())
    .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true })
    .lean<ServiceItemDoc>();
  return doc ? toServiceItem(doc) : undefined;
}

/* ── Reporting: the collections register (period on payment date, half-open) ── */

export interface CollectionsReport {
  /** Total money RECEIVED at the counter in the period, in paise. Excludes wallet settlements. */
  total: number;
  /** Number of individual payments taken (direct, non-wallet). */
  count: number;
  byMonth: { month: string; amount: number; count: number }[];
  byMethod: { method: string; amount: number; count: number }[];
  /**
   * Paise. Bills SETTLED FROM ADVANCE in the period (`method: "wallet"`). Reported apart from
   * `total` on purpose — this money already crossed the counter when it was deposited, so counting
   * it here as well would inflate the day's takings. See the wallet register for the advance story.
   */
  settledFromAdvance: number;
}

/**
 * Money actually RECEIVED in a period — not billed, received.
 *
 * Collections are the payments taken (`invoices.payments[].at`), never the invoice totals: an
 * auditor's "how much money came in during March" is answered by what crossed the counter that
 * month, which can lag or lead when the invoice was raised. The pipeline unwinds each invoice's
 * payments, keeps those whose `at` falls in the half-open `[from, to)` window, and groups by
 * month and by method (cash, card, UPI…). Amounts are paise; the UI divides by 100. Tenant-
 * scoped by the aggregate hook.
 */
export async function collectionsReport(from: Date, to: Date): Promise<CollectionsReport> {
  const model = getInvoiceModel(getTenantDb());
  const facet = await model.aggregate<{
    total: { amount: number; count: number }[];
    byMonth: { _id: string; amount: number; count: number }[];
    byMethod: { _id: string; amount: number; count: number }[];
    fromAdvance: { amount: number }[];
  }>([
    { $unwind: "$payments" },
    { $match: { "payments.at": { $gte: from, $lt: to } } },
    {
      $facet: {
        // Every figure below is DIRECT collection only — money that crossed the counter here. A
        // `method: "wallet"` payment is a bill settled from an advance already banked at deposit
        // time; folding it in would double-count it, so the drawer views exclude it and it is
        // surfaced apart in `fromAdvance`.
        total: [
          { $match: { "payments.method": { $ne: "wallet" } } },
          { $group: { _id: null, amount: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
        ],
        byMonth: [
          { $match: { "payments.method": { $ne: "wallet" } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$payments.at" } },
              amount: { $sum: "$payments.amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        byMethod: [
          { $match: { "payments.method": { $ne: "wallet" } } },
          {
            $group: {
              _id: "$payments.method",
              amount: { $sum: "$payments.amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { amount: -1 } },
        ],
        fromAdvance: [
          { $match: { "payments.method": "wallet" } },
          { $group: { _id: null, amount: { $sum: "$payments.amount" } } },
        ],
      },
    },
  ]);
  const f = facet[0];
  return {
    total: f?.total[0]?.amount ?? 0,
    count: f?.total[0]?.count ?? 0,
    byMonth: (f?.byMonth ?? []).map((r) => ({ month: r._id, amount: r.amount, count: r.count })),
    byMethod: (f?.byMethod ?? []).map((r) => ({ method: r._id, amount: r.amount, count: r.count })),
    settledFromAdvance: f?.fromAdvance[0]?.amount ?? 0,
  };
}

/* ── Reporting: revenue leakage (charges posted but never billed) ── */

export interface RevenueLeakageReport {
  /** Paise posted as a charge in the period but never put on a bill. The money at risk. */
  total: number;
  /** Number of unbilled charges. */
  count: number;
  byCategory: { category: string; amount: number; count: number }[];
  bySource: { source: string; amount: number; count: number }[];
  /** The visits carrying unbilled charges, heaviest first — where to go and bill. */
  byEncounter: { encounterId: string; patientId: string; amount: number; count: number }[];
}

/**
 * Money EARNED BUT NOT BILLED — the leak.
 *
 * A charge posts the moment care is given (a test ordered, a bed-day, a manual item); it becomes
 * money the hospital can collect only when it is FINALIZED onto a bill, which stamps its
 * `invoiceId`. A charge posted in the period, worth more than ₹0, not voided, and still carrying no
 * `invoiceId` is care the hospital gave and never charged for — revenue walking out of the door.
 * This finds it, sums it by category and by source, and lists the visits that hold it so someone
 * can raise the bills. Paise; tenant-scoped by the aggregate hook. The window is half-open on
 * `postedAt`, matching every other register.
 */
export async function revenueLeakage(from: Date, to: Date): Promise<RevenueLeakageReport> {
  const model = getChargeModel(getTenantDb());
  const facet = await model.aggregate<{
    total: { amount: number; count: number }[];
    byCategory: { _id: string; amount: number; count: number }[];
    bySource: { _id: string; amount: number; count: number }[];
    byEncounter: { _id: { e: Types.ObjectId; p: Types.ObjectId }; amount: number; count: number }[];
  }>([
    {
      $match: {
        postedAt: { $gte: from, $lt: to },
        amount: { $gt: 0 },
        voided: { $ne: true },
        invoiceId: { $exists: false },
      },
    },
    {
      $facet: {
        total: [{ $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }],
        byCategory: [
          { $group: { _id: "$category", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
        ],
        bySource: [
          { $group: { _id: "$source", amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
        ],
        byEncounter: [
          {
            $group: {
              _id: { e: "$encounterId", p: "$patientId" },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { amount: -1 } },
          { $limit: 50 },
        ],
      },
    },
  ]);
  const f = facet[0];
  return {
    total: f?.total[0]?.amount ?? 0,
    count: f?.total[0]?.count ?? 0,
    byCategory: (f?.byCategory ?? []).map((r) => ({
      category: r._id,
      amount: r.amount,
      count: r.count,
    })),
    bySource: (f?.bySource ?? []).map((r) => ({ source: r._id, amount: r.amount, count: r.count })),
    byEncounter: (f?.byEncounter ?? []).map((r) => ({
      encounterId: r._id.e.toString(),
      patientId: r._id.p.toString(),
      amount: r.amount,
      count: r.count,
    })),
  };
}

/* ── Charges ───────────────────────────────────────────────────────────────── */

export interface PostChargeInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  code: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  listPrice: number;
  amount: number;
  source: ChargeSource;
  sourceId?: string;
  branchId?: string;
  doctorId?: string;
}

/**
 * Posts a charge. Throws a duplicate-key error when this `sourceId`+`code` has already
 * been charged on this encounter — BY DESIGN.
 *
 * The outbox is at-least-once, so the consumer that bills a lab order WILL run twice.
 * Without the unique index (migration 0014) the patient pays for two blood tests and
 * only had one. The service catches the duplicate and treats it as done.
 */
export async function postCharge(input: PostChargeInput, session?: ClientSession): Promise<Charge> {
  const ctx = getContext();

  const [doc] = await getChargeModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        code: input.code.toUpperCase(),
        description: input.description,
        category: input.category,
        quantity: input.quantity,
        listPrice: input.listPrice,
        amount: input.amount,
        source: input.source,
        postedAt: new Date(),
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.doctorId ? { doctorId: input.doctorId } : {}),
        ...(ctx.userId ? { postedBy: ctx.userId } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("charge insert returned nothing");
  return toCharge(doc);
}

export async function chargesForEncounter(encounterId: string): Promise<Charge[]> {
  const docs = await getChargeModel(getTenantDb())
    .find({ encounterId: new Types.ObjectId(encounterId), voided: { $ne: true } })
    .sort({ postedAt: 1 })
    .lean<ChargeDoc[]>();
  return docs.map(toCharge);
}

/**
 * The charges on this visit NOT yet on any invoice — the "pending" bill.
 *
 * Per-batch billing is built on this: a charge with no `invoiceId` has not been billed, so it is
 * what the next bill covers. Finalizing moves this set onto a fresh invoice; anything ordered after
 * that is a new pending set for the next bill. Voided charges are excluded — a reversed charge is
 * not owed.
 */
export async function unbilledChargesForEncounter(encounterId: string): Promise<Charge[]> {
  const docs = await getChargeModel(getTenantDb())
    .find({
      encounterId: new Types.ObjectId(encounterId),
      voided: { $ne: true },
      invoiceId: { $exists: false },
    })
    .sort({ postedAt: 1 })
    .lean<ChargeDoc[]>();
  return docs.map(toCharge);
}

/**
 * The consultation charges across a SET of encounters — for reception's "has the OP fee been
 * paid?" gate. Filtered to `category: "consultation"` so a later test or pharmacy charge on the
 * same visit never counts toward whether the patient may join the doctor's queue.
 */
export async function consultationChargesForEncounters(encounterIds: string[]): Promise<Charge[]> {
  if (encounterIds.length === 0) return [];
  const objectIds = encounterIds.map((id) => new Types.ObjectId(id));
  const docs = await getChargeModel(getTenantDb())
    .find({
      encounterId: { $in: objectIds },
      category: "consultation",
      voided: { $ne: true },
    })
    .lean<ChargeDoc[]>();
  return docs.map(toCharge);
}

/**
 * Consultations this patient has already been CHARGED for with one doctor since `since` —
 * newest first. The raw material of the free-follow-up rule (`consultationFollowUp`).
 *
 * Only charges with an `amount > 0` qualify: a ₹0 line is either a government zero-tariff visit or
 * a follow-up that was itself waived, and neither can father a further free visit. Letting a waived
 * visit extend the window would make the entitlement roll forward for ever off a single payment.
 */
export async function paidConsultationsForDoctor(input: {
  patientId: string;
  doctorId: string;
  since: Date;
}): Promise<Charge[]> {
  if (!Types.ObjectId.isValid(input.patientId)) return [];
  const docs = await getChargeModel(getTenantDb())
    .find({
      patientId: new Types.ObjectId(input.patientId),
      doctorId: input.doctorId,
      category: "consultation",
      voided: { $ne: true },
      amount: { $gt: 0 },
      postedAt: { $gte: input.since },
    })
    .sort({ postedAt: -1 })
    .lean<ChargeDoc[]>();
  return docs.map(toCharge);
}

/** Every invoice raised on this visit (a visit can have several — consultation, tests, pharmacy). */
export async function invoicesForEncounter(encounterId: string): Promise<Invoice[]> {
  const docs = await getInvoiceModel(getTenantDb())
    .find({ encounterId: new Types.ObjectId(encounterId), status: { $ne: "cancelled" } })
    .sort({ createdAt: 1 })
    .lean<InvoiceDoc[]>();
  return docs.map(toInvoice);
}

/**
 * Reverses every unbilled charge raised by one cause — the order that was cancelled.
 *
 * Only charges NOT yet on a finalized invoice: once the bill is in the patient's hand,
 * reversing it is a credit note, which is a different document and a different
 * conversation with the cashier.
 */
export async function voidChargesBySource(sourceId: string, reason: string): Promise<number> {
  const result = await getChargeModel(getTenantDb()).updateMany(
    { sourceId, invoiceId: { $exists: false }, voided: { $ne: true } },
    { $set: { voided: true, voidReason: reason } },
  );
  return result.modifiedCount;
}

export async function voidCharge(id: string, reason: string): Promise<Charge | undefined> {
  const doc = await getChargeModel(getTenantDb())
    .findOneAndUpdate(
      // A charge already on a finalized invoice is frozen — reversing it is a credit
      // note, which is a different document and a different conversation.
      { _id: id, invoiceId: { $exists: false } },
      { $set: { voided: true, voidReason: reason } },
      { new: true },
    )
    .lean<ChargeDoc>();
  return doc ? toCharge(doc) : undefined;
}

/* ── Invoices ──────────────────────────────────────────────────────────────── */

export async function findInvoiceById(id: string): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOne({ _id: id, ...scopeFilter("finalizedBy") })
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
}

export async function findInvoiceForEncounter(encounterId: string): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), status: { $ne: "cancelled" } })
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
}

export async function createInvoice(
  input: {
    encounterId: string;
    patientId: string;
    episodeId: string;
    lines: InvoiceLine[];
    subtotal: number;
    total: number;
    branchId?: string;
  },
  session?: ClientSession,
): Promise<Invoice> {
  const ctx = getContext();

  const [doc] = await getInvoiceModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        status: "draft",
        lines: input.lines,
        subtotal: input.subtotal,
        discount: 0,
        total: input.total,
        paid: 0,
        payments: [],
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("invoice insert returned nothing");
  return toInvoice(doc);
}

/** Who this invoice is FOR — decides which series numbers it (ADR-0015). */
export interface InvoiceBranch {
  branchId?: string;
  branchCode?: string;
  isMain?: boolean;
}

/**
 * The invoice number.
 *
 * Atomic `$inc` on a counter — the same mechanism as the UHID and the queue token, and
 * for the same reason: two cashiers finalizing at the same instant must not both be
 * handed `INV-2026-0042`. A duplicate invoice number is a tax problem, not a display bug.
 *
 * ── PER-BRANCH SERIES (ADR-0015) ─────────────────────────────────────────────
 * A branch is usually a separate place of supply, so it wants its OWN running series,
 * not a slice of a tenant-wide one. So each NON-MAIN branch gets its own counter
 * (`invoice:{branchId}:{year}`) and its code in the number (`INV-CHN-2026-00042`).
 *
 * The MAIN branch — and any hospital that predates branches (no `branchId`) — stays on
 * the original tenant-wide counter (`invoice:{year}`) and the original format
 * (`INV-2026-00042`). That is deliberate, not laziness: a single-site hospital sees NO
 * change, and a hospital that opens a second branch does not restart or reformat the
 * numbers its first site has already issued. The two namespaces (coded vs not) can never
 * collide, so the tenant-wide uniqueness index still holds.
 */
export async function nextInvoiceNumber(
  branch: InvoiceBranch = {},
  session?: ClientSession,
): Promise<string> {
  const ctx = getContext();
  const year = new Date().getFullYear();

  // Only a NON-MAIN branch gets its own series; Main and branchless share the original one.
  const ownSeries = Boolean(branch.branchId && branch.branchCode && !branch.isMain);
  const counterId = ownSeries ? `invoice:${branch.branchId}:${year}` : `invoice:${year}`;

  const result = await ctx.connection
    .collection<{ _id: string; tenantId: string; seq: number }>("counters")
    .findOneAndUpdate(
      { _id: counterId },
      { $inc: { seq: 1 }, $setOnInsert: { tenantId: ctx.tenantId } },
      { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
    );

  const seq = result?.seq;
  if (typeof seq !== "number") throw new Error("invoice number allocation failed");
  const prefix = ownSeries ? `INV-${branch.branchCode}-` : "INV-";
  return `${prefix}${String(year)}-${String(seq).padStart(5, "0")}`;
}

export async function updateInvoice(
  id: string,
  set: Record<string, unknown>,
  session?: ClientSession,
): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOneAndUpdate({ _id: id }, { $set: set }, { new: true, ...(session ? { session } : {}) })
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
}

export async function addPayment(
  id: string,
  payment: PaymentEntry,
  status: InvoiceStatus,
  paid: number,
  session?: ClientSession,
): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      { $push: { payments: payment }, $set: { paid, status } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
}

/** Records money handed back. `refunded` is the new running total, not a delta — the caller computed it. */
export async function addRefund(
  id: string,
  refund: RefundEntry,
  refunded: number,
  session?: ClientSession,
): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      { $push: { refunds: refund }, $set: { refunded } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
}

/**
 * Attaches a SPECIFIC set of charges (by id) to the invoice they were frozen into. Used by
 * per-batch finalize: only the charges whose lines went on this invoice are marked billed, so a
 * charge that arrives between reading the pending set and this write is NOT swept onto a bill it is
 * not on. The `invoiceId: { $exists: false }` guard keeps it idempotent.
 */
export async function attachChargesToInvoiceByIds(
  chargeIds: string[],
  invoiceId: string,
  session?: ClientSession,
): Promise<void> {
  if (chargeIds.length === 0) return;
  await getChargeModel(getTenantDb()).updateMany(
    {
      _id: { $in: chargeIds.map((id) => new Types.ObjectId(id)) },
      invoiceId: { $exists: false },
    },
    { $set: { invoiceId: new Types.ObjectId(invoiceId) } },
    session ? { session } : {},
  );
}

/** Attaches charges to the invoice they were frozen into. */
export async function attachChargesToInvoice(
  encounterId: string,
  invoiceId: string,
  session?: ClientSession,
): Promise<void> {
  await getChargeModel(getTenantDb()).updateMany(
    {
      encounterId: new Types.ObjectId(encounterId),
      voided: { $ne: true },
      invoiceId: { $exists: false },
    },
    { $set: { invoiceId: new Types.ObjectId(invoiceId) } },
    session ? { session } : {},
  );
}

export async function listInvoices(filter: {
  status?: InvoiceStatus;
  patientId?: string;
  limit: number;
  skip: number;
}): Promise<{ items: Invoice[]; total: number }> {
  const model = getInvoiceModel(getTenantDb());
  const query: Record<string, unknown> = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.patientId ? { patientId: new Types.ObjectId(filter.patientId) } : {}),
  };

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ createdAt: -1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<InvoiceDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toInvoice), total };
}

/**
 * Move a merged patient's charges AND invoices onto the survivor (patient.patients.merged).
 * Both collections carry patientId; the survivor must inherit the money owed on either.
 * Returns the total rows moved across both. Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  const conn = getTenantDb();
  const charges = await repointPatientId(getChargeModel(conn), "patientId", ref, {
    objectId: true,
  });
  const invoices = await repointPatientId(getInvoiceModel(conn), "patientId", ref, {
    objectId: true,
  });
  return charges + invoices;
}

/**
 * The charges caused by a set of orders (or other sources), for a payment-status lookup.
 *
 * Projected to the three fields the check needs — what it is worth, and which invoice (if any) it
 * has been rolled into — never the whole charge. Voided charges are excluded: a reversed charge is
 * not something the patient owes. Tenant-isolated by the query hook.
 */
export async function chargesForSources(
  sourceIds: string[],
): Promise<{ sourceId: string; amount: number; invoiceId?: string; encounterId: string }[]> {
  if (sourceIds.length === 0) return [];
  const docs = await getChargeModel(getTenantDb())
    .find(
      { sourceId: { $in: sourceIds }, voided: { $ne: true } },
      { sourceId: 1, amount: 1, invoiceId: 1, encounterId: 1 },
    )
    .lean<
      {
        sourceId?: string;
        amount: number;
        invoiceId?: Types.ObjectId;
        encounterId: Types.ObjectId;
      }[]
    >();

  return docs
    .filter(
      (
        d,
      ): d is {
        sourceId: string;
        amount: number;
        invoiceId?: Types.ObjectId;
        encounterId: Types.ObjectId;
      } => Boolean(d.sourceId),
    )
    .map((d) => ({
      sourceId: d.sourceId,
      amount: d.amount,
      encounterId: d.encounterId.toString(),
      ...(d.invoiceId ? { invoiceId: d.invoiceId.toString() } : {}),
    }));
}

/** Every live (non-voided) charge caused by one source (an order), in FULL — for settling it. */
export async function fullChargesForSource(sourceId: string): Promise<Charge[]> {
  const docs = await getChargeModel(getTenantDb())
    .find({ sourceId, voided: { $ne: true } })
    .sort({ postedAt: 1 })
    .lean<ChargeDoc[]>();
  return docs.map(toCharge);
}

export interface BillReceipt {
  invoiceId: string;
  number?: string;
  patientId: string;
  paid: number;
  total: number;
  at: Date;
}

/**
 * Issued bills with money on them in a period `[from, to)` — the bill half of the receipts register.
 * Only invoices that have been finalized (so they carry a number) and have taken at least one payment
 * count as a receipt. Dated by `finalizedAt` — when the bill was raised at the counter.
 */
export async function receiptsBetween(from: Date, to: Date): Promise<BillReceipt[]> {
  const docs = await getInvoiceModel(getTenantDb())
    .find(
      {
        status: { $in: ["finalized", "paid"] },
        paid: { $gt: 0 },
        finalizedAt: { $gte: from, $lt: to },
      },
      { number: 1, patientId: 1, paid: 1, total: 1, finalizedAt: 1 },
    )
    .sort({ finalizedAt: -1 })
    .limit(500)
    .lean<
      {
        _id: Types.ObjectId;
        number?: string;
        patientId: Types.ObjectId;
        paid: number;
        total: number;
        finalizedAt?: Date;
      }[]
    >();

  return docs.map((d) => ({
    invoiceId: d._id.toString(),
    patientId: d.patientId.toString(),
    paid: d.paid,
    total: d.total,
    at: d.finalizedAt ?? new Date(),
    ...(d.number ? { number: d.number } : {}),
  }));
}

/** The status of a set of invoices by id — for tracing whether a charge has been paid. */
export async function invoiceStatusByIds(ids: string[]): Promise<Map<string, string>> {
  const objectIds = ids.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
  if (objectIds.length === 0) return new Map();
  const docs = await getInvoiceModel(getTenantDb())
    .find({ _id: { $in: objectIds } }, { status: 1 })
    .lean<{ _id: Types.ObjectId; status: string }[]>();
  return new Map(docs.map((d) => [d._id.toString(), d.status]));
}
