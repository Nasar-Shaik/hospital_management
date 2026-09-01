/**
 * The general store — three collections: what the hospital stocks, what is on each site's shelf,
 * and every unit that moved.
 *
 * ── WHY THIS IS NOT THE PHARMACY ────────────────────────────────────────────
 * The shape is the pharmacy's, deliberately: a master, a running balance, and an append-only
 * signed ledger that explains it. That pattern is proven (`medicine.model.ts`) and reusing it is
 * the whole reason this module is small. What is NOT reused is the TABLES. A glove is not a drug:
 * it has no form, no strength, no generic name, it must never appear on a prescribing pad, and
 * `GET /medicines/availability` must never offer it to a doctor. Putting consumables into
 * `medicines` would put them in every one of those places.
 *
 * ── AND WHERE IT DELIBERATELY DIVERGES: THE BALANCE IS PER SITE ─────────────
 * The pharmacy holds ONE hospital-wide `stockUnits` on the master, and `batch.model.ts` explains
 * why it did not split it: an existing balance would have to be divided between sites and this
 * milestone does not invent an answer to that.
 *
 * That objection does not reach here — these collections are new and there is no balance to
 * divide — and the positive case is stronger. A store is a ROOM. Main Branch's store and the
 * annexe's store are different shelves with different keepers, and one shared number would make
 * "we have 400 gloves" true of a hospital where one site has 400 and the other has none. Low
 * stock, which is the whole point of the reorder level, would be unanswerable.
 *
 * So the balance lives in `inventoryStock`, one row per (item, branch), and the master carries no
 * balance at all. That also removes the mirror the pharmacy has to keep in step: there is exactly
 * one number, not a ledger and a copy of its total.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * No purchase orders, no goods-received-note approval, no sub-stores or bins, no batch or expiry
 * (that is the drug shelf's hard-won complexity and consumables do not earn it), no ABC analysis,
 * no auto-reorder, no patient-level consumable billing, no inter-branch transfer.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * What kind of thing this is. Six buckets, chosen because they are the six a store keeper
 * actually walks past — not a taxonomy. It drives grouping and nothing else; no rule anywhere
 * behaves differently per category, which is why adding a seventh later costs nothing.
 */
export const ITEM_CATEGORIES = [
  "consumable",
  "linen",
  "stationery",
  "housekeeping",
  "spare",
  "other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * The unit stock is counted in. An enum rather than free text so the same thing is not received
 * in "pcs", counted in "piece" and issued in "Pieces" — three balances for one box of gloves.
 */
export const ITEM_UNITS = [
  "piece",
  "box",
  "pack",
  "pair",
  "roll",
  "metre",
  "litre",
  "kilogram",
] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** How a unit came to move. The `kind` an inspector reads off the ledger. */
export const MOVEMENT_KINDS = ["receipt", "issue", "adjustment"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/* ── 1. the master ─────────────────────────────────────────────────────────── */

export interface InventoryItemDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** Unique per tenant. The key a receipt, an issue and the ledger all match on. */
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;

  /**
   * At or below this, the store list calls the item low. Zero means "do not flag".
   *
   * One level per ITEM, hospital-wide, even though the balance is per site. A per-site reorder
   * level is a real thing a big hospital wants and a second decision to model; one number is
   * right for the hospitals this is for, and being wrong about it costs a flag, not stock.
   */
  reorderLevel: number;

  /** A discontinued item keeps its history and leaves the list. */
  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<InventoryItemDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: ITEM_CATEGORIES, required: true },
    unit: { type: String, enum: ITEM_UNITS, required: true },
    reorderLevel: { type: Number, required: true, default: 0, min: 0 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "inventoryItems", autoIndex: false },
);

itemSchema.plugin(tenantScopePlugin);
/** `admin` — the master is configuration. It names no patient and holds no money. */
itemSchema.plugin(auditPlugin, { resource: "inventoryItem", category: "admin" });

export function getInventoryItemModel(conn: Connection): Model<InventoryItemDoc> {
  return (
    (conn.models.InventoryItem as Model<InventoryItemDoc>) ??
    conn.model<InventoryItemDoc>("InventoryItem", itemSchema)
  );
}

/* ── 2. the shelf, per site ────────────────────────────────────────────────── */

export interface InventoryStockDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /**
   * The site this shelf is at. Optional for the same reason every other operational collection's
   * is: a tenant provisioned before branches existed writes branchless, and `writeBranchId()`
   * returns `undefined` for it rather than failing. Such a tenant simply has one unnamed shelf.
   */
  branchId?: string;

  itemId: Types.ObjectId;
  /** Denormalized so a shelf row reads without a join back to the master. */
  itemCode: string;

  /**
   * Units on this site's shelf. Never negative, and that is enforced by the QUERY, not by an
   * `if`: every path that reduces it is a conditional update requiring `onHand >= quantity`.
   *
   * ── AND THAT IS THE ONE PLACE THIS DISAGREES WITH THE PHARMACY ─────────────
   * `medicines.stockUnits` is allowed to go negative and is reported as `reconcile`, because the
   * drugs have ALREADY crossed the counter by the time the ledger hears about it and a
   * bookkeeping problem must never hold a patient's medicine.
   *
   * Nothing of the kind is true here. Nobody is standing at a counter; the store keeper is
   * holding the box and can count it. An issue of forty when thirty are on the shelf is not an
   * event that already happened — it is a mistake being made right now, and refusing it is how
   * the store keeper finds out before the ward does.
   */
  onHand: number;

  createdAt: Date;
  updatedAt: Date;
}

const stockSchema = new Schema<InventoryStockDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    itemId: { type: Schema.Types.ObjectId, required: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },

    onHand: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: "inventoryStock", autoIndex: false },
);

stockSchema.plugin(tenantScopePlugin);
/** `financial` — stock is an asset the hospital paid for, and its balance is a financial fact. */
stockSchema.plugin(auditPlugin, { resource: "inventoryStock", category: "financial" });

export function getInventoryStockModel(conn: Connection): Model<InventoryStockDoc> {
  return (
    (conn.models.InventoryStock as Model<InventoryStockDoc>) ??
    conn.model<InventoryStockDoc>("InventoryStock", stockSchema)
  );
}

/* ── 3. the ledger ─────────────────────────────────────────────────────────── */

export interface InventoryMovementDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  itemId: Types.ObjectId;
  itemCode: string;

  kind: MovementKind;
  /**
   * The SIGNED change: positive for a receipt, negative for an issue, either for an adjustment.
   * Signing it rather than carrying a direction flag means the balance is a plain sum and the two
   * can never disagree.
   */
  delta: number;
  /** The shelf immediately AFTER this movement — the ledger carries its own running total. */
  balanceAfter: number;

  /** A receipt's provenance. Names are captured AT THE TIME, see the repository. */
  supplierId?: Types.ObjectId;
  supplierName?: string;
  /** The supplier's invoice or delivery-note reference, as printed on the paper. */
  invoiceRef?: string;
  /** What one unit cost on this delivery. Recorded, never summed into a payables ledger. */
  unitCost?: number;

  /** An issue's destination. */
  departmentId?: Types.ObjectId;
  departmentName?: string;

  /** Why an adjustment happened — a stock-take, breakage, a write-off. */
  reason?: string;

  createdBy: string;
  createdAt: Date;
}

const movementSchema = new Schema<InventoryMovementDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    itemId: { type: Schema.Types.ObjectId, required: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },

    kind: { type: String, enum: MOVEMENT_KINDS, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    supplierId: { type: Schema.Types.ObjectId },
    supplierName: { type: String, trim: true, maxlength: 200 },
    invoiceRef: { type: String, trim: true, maxlength: 120 },
    unitCost: { type: Number, min: 0 },

    departmentId: { type: Schema.Types.ObjectId },
    departmentName: { type: String, trim: true, maxlength: 200 },

    reason: { type: String, trim: true, maxlength: 300 },

    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  // No `updatedAt`: a ledger row is written once and never touched again.
  { timestamps: false, collection: "inventoryMovements", autoIndex: false },
);

movementSchema.plugin(tenantScopePlugin);
/** `financial` — same as the pharmacy's ledger, and for the same reason. */
movementSchema.plugin(auditPlugin, { resource: "inventoryMovement", category: "financial" });

export function getInventoryMovementModel(conn: Connection): Model<InventoryMovementDoc> {
  return (
    (conn.models.InventoryMovement as Model<InventoryMovementDoc>) ??
    conn.model<InventoryMovementDoc>("InventoryMovement", movementSchema)
  );
}

/** How the store list reads an item's position at the shelf it is looking at. */
export type StockPosition = "ok" | "low" | "out";

export function positionOf(onHand: number, reorderLevel: number): StockPosition {
  if (onHand <= 0) return "out";
  if (reorderLevel > 0 && onHand <= reorderLevel) return "low";
  return "ok";
}
