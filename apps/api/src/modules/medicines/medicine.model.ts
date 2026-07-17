/**
 * The pharmacy's medicine master and its stock ledger — two collections, one module.
 *
 * ── THE MASTER IS WHAT THE HOSPITAL STOCKS; THE LEDGER IS WHAT MOVED ─────────
 * `medicines` is the catalogue the pharmacist maintains: the brand, the company that makes
 * it, the salt it actually is, how it is packed. `stockMovements` is an append-only ledger
 * of every unit that came in (a receipt) or went out (a dispense) or was corrected (an
 * adjustment). Current stock is not a field somebody edits — it is the running balance the
 * ledger produces, mirrored onto the master as `stockUnits` so a list can read it without
 * summing the whole ledger every time.
 *
 * ── WHY A LEDGER AND NOT JUST A NUMBER ──────────────────────────────────────
 * A bare "42 in stock" answers no question an auditor asks. A ledger answers all of them:
 * when did we receive this batch, when did it expire, who dispensed the six that left on
 * Tuesday. The mirrored `stockUnits` is a convenience for the screen; the ledger is the
 * truth, and the two are written together (see the repository) so they cannot drift.
 *
 * ── STOCK IS ALLOWED TO GO NEGATIVE, ON PURPOSE ─────────────────────────────
 * Dispensing never blocks on stock (STATE_MACHINE_CATALOG §6, and the pharmacy service says
 * it plainly): a patient is handed their medicine whether or not the shelf count agrees. So
 * a balance can fall below zero — and when it does, that is not a bug to hide but a fact to
 * surface: it means drugs left the counter that were never booked in. The stock report flags
 * it as "reconcile", rather than a clamp at zero pretending the discrepancy away.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** The physical form a medicine takes — drives how a quantity reads (tablets vs. ml). */
export const MEDICINE_FORMS = [
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "ointment",
  "drops",
  "inhaler",
  "sachet",
  "other",
] as const;
export type MedicineForm = (typeof MEDICINE_FORMS)[number];

/** How a unit of stock came to move. The `kind` an inspector reads off the ledger. */
export const STOCK_MOVEMENT_KINDS = ["receipt", "dispense", "adjustment"] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

export interface MedicineDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /**
   * The code an order and a dispense carry. Unique per tenant. It is the SAME code space the
   * prescription pad and the tariff use — that shared key is how a dispense finds its
   * medicine to decrement, with no second mapping table to keep in step.
   */
  code: string;
  /** The brand as it is written on the strip. */
  name: string;
  /** The company that manufactures it. */
  manufacturer?: string;
  /** The salt / combination — what it clinically IS, e.g. "Paracetamol 500mg + Caffeine 65mg". */
  generic?: string;
  form: MedicineForm;
  /** Free text: "500 mg", "5 mg/5 ml". Not parsed — printed. */
  strength?: string;

  /** Tablets (or units) per sheet/strip. For reading a pack down into base units. */
  unitsPerSheet?: number;
  /** Sheets/strips per pack. Reporting only — stock is always counted in base units. */
  sheetsPerPack?: number;

  /**
   * The running balance in BASE UNITS (individual tablets, ml, vials), mirrored from the
   * ledger. Never edited directly — `receiveStock`/`adjustStock`/`recordDispense` move it in
   * the same write as the movement that explains it.
   */
  stockUnits: number;
  /** Below this, the stock report calls the medicine low. Zero means "do not alert". */
  reorderLevel: number;

  /** A retired medicine stays for its history but is hidden from the prescribing list. */
  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const medicineSchema = new Schema<MedicineDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    manufacturer: { type: String, trim: true, maxlength: 200 },
    generic: { type: String, trim: true, maxlength: 300 },
    form: { type: String, enum: MEDICINE_FORMS, required: true },
    strength: { type: String, trim: true, maxlength: 80 },

    unitsPerSheet: { type: Number, min: 1, max: 10_000 },
    sheetsPerPack: { type: Number, min: 1, max: 10_000 },

    stockUnits: { type: Number, required: true, default: 0 },
    reorderLevel: { type: Number, required: true, default: 0, min: 0 },

    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "medicines", autoIndex: false },
);

medicineSchema.plugin(tenantScopePlugin);
/**
 * `admin` — the master is configuration, not PHI: it names no patient. Changing what the
 * pharmacy stocks, or retiring a medicine, is exactly the kind of quiet edit a hospital wants
 * a trail of.
 */
medicineSchema.plugin(auditPlugin, { resource: "medicine", category: "admin" });

export function getMedicineModel(conn: Connection): Model<MedicineDoc> {
  return (
    (conn.models.Medicine as Model<MedicineDoc>) ??
    conn.model<MedicineDoc>("Medicine", medicineSchema)
  );
}

export interface StockMovementDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  medicineId: Types.ObjectId;
  /** Denormalized so the ledger reads without a join back to the master. */
  medicineCode: string;

  kind: StockMovementKind;
  /**
   * The SIGNED change in base units: positive for a receipt, negative for a dispense, either
   * for an adjustment. Signing it (rather than a separate direction flag) means the balance
   * is a plain sum and can never disagree with the sign.
   */
  delta: number;
  /** The balance immediately AFTER this movement — the ledger carries its own running total. */
  balanceAfter: number;

  /** A receipt's batch and expiry, when the pharmacist recorded them. */
  batchNo?: string;
  expiry?: Date;
  /** Why an adjustment happened — breakage, a stock-take correction. */
  reason?: string;
  /** The dispense this movement answers, when `kind` is `dispense`. */
  dispenseId?: Types.ObjectId;

  createdBy: string;
  createdAt: Date;
}

const stockMovementSchema = new Schema<StockMovementDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    medicineId: { type: Schema.Types.ObjectId, required: true },
    medicineCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },

    kind: { type: String, enum: STOCK_MOVEMENT_KINDS, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    batchNo: { type: String, trim: true, maxlength: 80 },
    expiry: { type: Date },
    reason: { type: String, trim: true, maxlength: 300 },
    dispenseId: { type: Schema.Types.ObjectId },

    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  // No `updatedAt`: a ledger row is written once and never touched again.
  { timestamps: false, collection: "stockMovements", autoIndex: false },
);

stockMovementSchema.plugin(tenantScopePlugin);
/** `financial` — stock is an asset that moves; its ledger is a financial record. */
stockMovementSchema.plugin(auditPlugin, { resource: "stockMovement", category: "financial" });

export function getStockMovementModel(conn: Connection): Model<StockMovementDoc> {
  return (
    (conn.models.StockMovement as Model<StockMovementDoc>) ??
    conn.model<StockMovementDoc>("StockMovement", stockMovementSchema)
  );
}
