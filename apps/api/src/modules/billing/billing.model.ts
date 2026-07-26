/**
 * Billing — the charge ledger (Doc 02 F-group).
 *
 * ── MONEY IS AN INTEGER NUMBER OF PAISE. NEVER A FLOAT ──────────────────────
 * ₹150.50 is 15050. `0.1 + 0.2 !== 0.3` in IEEE-754, and a hospital that cannot
 * reconcile its day's takings to the rupee stops trusting the software — rightly.
 * Every amount in this module is paise, everywhere, and only the UI divides by 100.
 *
 * ── A CHARGE IS POSTED AGAINST THE ENCOUNTER ────────────────────────────────
 * Not against the patient, not against the appointment. The encounter is the visit,
 * and the visit is the thing that gets billed (ADR-0013). This is the payoff for
 * making Encounter central: "what does this visit cost?" is one query, and it is
 * correct for a walk-in, a booked patient and an admission alike.
 *
 * ── zero_tariff IS A TARIFF, NOT AN OFF-SWITCH ──────────────────────────────
 * A government hospital posts every charge at ₹0 and still produces a real invoice
 * with real line items. It is free to the PATIENT; it is not free to the STATE, which
 * must still report drug consumption and per-patient cost. So a charge carries BOTH:
 *
 *   listPrice — what this care is worth (the tariff). Always populated.
 *   amount    — what the patient owes. ₹0 under zero_tariff.
 *
 * The patient pays nothing and the state can still cost the encounter. One line of
 * policy (see `billing.service.ts`), and no code anywhere reads `organizationType`.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** What kind of thing was charged for. Mirrors the order categories, plus the desk. */
export const CHARGE_CATEGORIES = [
  "consultation",
  "lab",
  "radiology",
  "pharmacy",
  "procedure",
  "bed",
  "other",
] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

/* ── The tariff master ─────────────────────────────────────────────────────── */

export interface ServiceItemDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** `CONSULT_GEN`, `CBC`, `XRAY_CHEST_PA` — the code an order carries. */
  code: string;
  name: string;
  category: ChargeCategory;
  /** Paise. The list price of this service at THIS hospital. */
  price: number;
  /**
   * Consultation only: how many days this fee keeps the patient entitled to see the SAME doctor
   * again for free (the "OP validity" every hospital advertises — pay once, revisit within N days).
   *
   * It lives on the tariff entry because it is a property of what the fee BUYS, and the price list
   * is the one page where a hospital already decides what a consultation is worth. Absent or 0
   * means no free follow-up: every visit is charged, which is the safe default for an existing
   * hospital that never configured one.
   */
  followUpDays?: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const serviceItemSchema = new Schema<ServiceItemDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: CHARGE_CATEGORIES, required: true },
    price: { type: Number, required: true, min: 0 },
    followUpDays: { type: Number, min: 0, max: 365 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "serviceItems", autoIndex: false },
);

serviceItemSchema.plugin(tenantScopePlugin);
// The price list is not PHI, but changing it silently is how a hospital discovers it
// has been undercharging for a month. `financial`, and audited.
serviceItemSchema.plugin(auditPlugin, { resource: "serviceItem", category: "financial" });

/* ── The charge ledger ─────────────────────────────────────────────────────── */

/** Where the charge came from. `sourceId` is the order/prescription/encounter it names. */
export const CHARGE_SOURCES = ["encounter", "order", "pharmacy", "bed", "manual"] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

export interface ChargeDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  episodeId: Types.ObjectId;

  code: string;
  description: string;
  category: ChargeCategory;

  quantity: number;
  /** Paise. What this is WORTH — populated even when the patient owes nothing. */
  listPrice: number;
  /** Paise. `listPrice * quantity`, or 0 under `zero_tariff`. What is OWED. */
  amount: number;

  source: ChargeSource;
  /**
   * The thing that caused this charge — an orderId, a prescriptionId.
   *
   * Unique with `code` per encounter when present (migration 0014): the outbox is
   * at-least-once, so the charge consumer WILL run twice on the same order, and
   * without the index the patient is billed twice for one blood test.
   */
  sourceId?: string;

  /**
   * Consultation charges only: WHOSE consultation this was.
   *
   * Denormalised onto the charge because the free-follow-up rule asks a money question — "has this
   * patient already paid to see THIS doctor recently?" — and it must be answerable inside billing,
   * from billing's own collection. Joining out to encounters to discover the doctor would put a
   * clinical read on the hot path of every registration and blur a module boundary for a fact the
   * charge can simply carry.
   */
  doctorId?: string;

  postedBy?: string;
  postedAt: Date;

  /** Set when the bill is finalized — a charge on a finalized bill cannot move. */
  invoiceId?: Types.ObjectId;

  /** Reversal is a flag, never a delete: money that vanishes cannot be audited. */
  voided?: boolean;
  voidReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const chargeSchema = new Schema<ChargeDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: CHARGE_CATEGORIES, required: true },

    quantity: { type: Number, required: true, min: 1, default: 1 },
    listPrice: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },

    source: { type: String, enum: CHARGE_SOURCES, required: true },
    sourceId: { type: String },

    doctorId: { type: String },

    postedBy: { type: String },
    postedAt: { type: Date, required: true },

    invoiceId: { type: Schema.Types.ObjectId },

    voided: { type: Boolean },
    voidReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true, collection: "charges", autoIndex: false },
);

chargeSchema.plugin(tenantScopePlugin);
/**
 * `financial` AND effectively PHI: a line item reading "HIV ELISA" on a bill discloses
 * the test as surely as the result does. Bills get handed across a counter.
 */
chargeSchema.plugin(auditPlugin, { resource: "charge", category: "financial" });

/* ── Invoices ──────────────────────────────────────────────────────────────── */

export const INVOICE_STATUSES = ["draft", "finalized", "paid", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * STATE_MACHINE_CATALOG §4, reduced to what a bill actually needs today.
 *
 * `finalized` is the one that matters: it assigns the invoice number and FREEZES the
 * lines. An invoice that can be edited after it is handed to a patient is not a
 * document, it is a suggestion — and it is how a hospital loses an audit.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["finalized", "cancelled"],
  finalized: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

export interface InvoiceLine {
  code: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  listPrice: number;
  amount: number;
}

export interface PaymentEntry {
  amount: number;
  method: string;
  reference?: string;
  at: Date;
  by?: string;
}

export interface InvoiceDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  episodeId: Types.ObjectId;

  /** Assigned at `finalized`, from an atomic counter. Never before. */
  number?: string;
  status: InvoiceStatus;

  lines: InvoiceLine[];
  /** Paise. */
  subtotal: number;
  discount: number;
  total: number;
  paid: number;

  payments: PaymentEntry[];

  finalizedAt?: Date;
  finalizedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    number: { type: String },
    status: { type: String, enum: INVOICE_STATUSES, required: true, default: "draft" },

    lines: [
      {
        _id: false,
        code: { type: String, required: true },
        description: { type: String, required: true },
        category: { type: String, required: true },
        quantity: { type: Number, required: true },
        listPrice: { type: Number, required: true },
        amount: { type: Number, required: true },
      },
    ],
    subtotal: { type: Number, required: true, default: 0 },
    discount: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },
    paid: { type: Number, required: true, default: 0 },

    payments: [
      {
        _id: false,
        amount: { type: Number, required: true },
        method: { type: String, required: true },
        reference: { type: String },
        at: { type: Date, required: true },
        by: { type: String },
      },
    ],

    finalizedAt: { type: Date },
    finalizedBy: { type: String },
  },
  { timestamps: true, collection: "invoices", autoIndex: false },
);

invoiceSchema.plugin(tenantScopePlugin);
invoiceSchema.plugin(auditPlugin, { resource: "invoice", category: "financial" });

export function getServiceItemModel(conn: Connection): Model<ServiceItemDoc> {
  return (
    (conn.models.ServiceItem as Model<ServiceItemDoc>) ??
    conn.model<ServiceItemDoc>("ServiceItem", serviceItemSchema)
  );
}

export function getChargeModel(conn: Connection): Model<ChargeDoc> {
  return (conn.models.Charge as Model<ChargeDoc>) ?? conn.model<ChargeDoc>("Charge", chargeSchema);
}

export function getInvoiceModel(conn: Connection): Model<InvoiceDoc> {
  return (
    (conn.models.Invoice as Model<InvoiceDoc>) ?? conn.model<InvoiceDoc>("Invoice", invoiceSchema)
  );
}
