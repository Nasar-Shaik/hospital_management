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
  type ServiceItemDoc,
} from "./billing.model.js";

export { isDuplicateKey };

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: ChargeCategory;
  price: number;
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
  total: number;
  paid: number;
  payments: PaymentEntry[];
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
    payments: d.payments ?? [],
    createdAt: d.createdAt,
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
}

export async function createService(input: CreateServiceInput): Promise<ServiceItem> {
  const ctx = getContext();
  const doc = await getServiceItemModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code,
    name: input.name,
    category: input.category,
    price: input.price,
    active: true,
  });
  return toServiceItem(doc.toObject() as ServiceItemDoc);
}

/** Editable fields of a tariff entry. NOT `code` or `category` — those define what it IS. */
export interface UpdateServiceInput {
  name?: string;
  price?: number;
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
  /** Total money RECEIVED in the period, in paise. */
  total: number;
  /** Number of individual payments taken. */
  count: number;
  byMonth: { month: string; amount: number; count: number }[];
  byMethod: { method: string; amount: number; count: number }[];
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
  }>([
    { $unwind: "$payments" },
    { $match: { "payments.at": { $gte: from, $lt: to } } },
    {
      $facet: {
        total: [
          { $group: { _id: null, amount: { $sum: "$payments.amount" }, count: { $sum: 1 } } },
        ],
        byMonth: [
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
          {
            $group: {
              _id: "$payments.method",
              amount: { $sum: "$payments.amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { amount: -1 } },
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

/**
 * The invoice number.
 *
 * Atomic `$inc` on a per-year counter — the same mechanism as the UHID and the queue
 * token, and for the same reason: two cashiers finalizing at the same instant must not
 * both be handed `INV-2026-0042`. A duplicate invoice number is a tax problem, not a
 * display bug.
 */
export async function nextInvoiceNumber(session?: ClientSession): Promise<string> {
  const ctx = getContext();
  const year = new Date().getFullYear();

  const result = await ctx.connection
    .collection<{ _id: string; tenantId: string; seq: number }>("counters")
    .findOneAndUpdate(
      { _id: `invoice:${year}` },
      { $inc: { seq: 1 }, $setOnInsert: { tenantId: ctx.tenantId } },
      { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
    );

  const seq = result?.seq;
  if (typeof seq !== "number") throw new Error("invoice number allocation failed");
  return `INV-${String(year)}-${String(seq).padStart(5, "0")}`;
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
): Promise<Invoice | undefined> {
  const doc = await getInvoiceModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      { $push: { payments: payment }, $set: { paid, status } },
      { new: true },
    )
    .lean<InvoiceDoc>();
  return doc ? toInvoice(doc) : undefined;
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
): Promise<{ sourceId: string; amount: number; invoiceId?: string }[]> {
  if (sourceIds.length === 0) return [];
  const docs = await getChargeModel(getTenantDb())
    .find(
      { sourceId: { $in: sourceIds }, voided: { $ne: true } },
      { sourceId: 1, amount: 1, invoiceId: 1 },
    )
    .lean<{ sourceId?: string; amount: number; invoiceId?: Types.ObjectId }[]>();

  return docs
    .filter((d): d is { sourceId: string; amount: number; invoiceId?: Types.ObjectId } =>
      Boolean(d.sourceId),
    )
    .map((d) => ({
      sourceId: d.sourceId,
      amount: d.amount,
      ...(d.invoiceId ? { invoiceId: d.invoiceId.toString() } : {}),
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
