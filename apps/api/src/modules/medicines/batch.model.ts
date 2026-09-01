/**
 * A medicine's stock, BY BATCH — the smallest model that makes expiry mean something.
 *
 * ── WHAT WAS WRONG WITH THE SCALAR ──────────────────────────────────────────
 * `medicines.stockUnits` is one running number, and `stockMovements` carried `batchNo` and
 * `expiry` on receipt. That records what arrived and can never answer what is on the shelf NOW:
 * two deliveries of the same drug expiring nine months apart collapse into a single total, so
 * nothing can prefer the older one and nothing can refuse the expired one. Expiry was captured
 * and never read — the whole point of writing it down.
 *
 * ── WHY A COLLECTION AND NOT A SUBDOCUMENT ARRAY ────────────────────────────
 * A batch is claimed under concurrency: two pharmacists reaching for the same last twenty
 * tablets must not both get them. That arbitration has to be a conditional update on a single
 * document (`remaining >= qty`), and an array element cannot be conditionally decremented
 * without either rewriting the whole array or resorting to a read-then-write — which is the race
 * itself. One document per batch makes the guard a one-line query, which is the same reasoning
 * `addDispensedQty` and the bed-occupancy index already follow: correctness by database.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────
 * Not a warehouse. There are no locations, no bins, no transfers, no purchase orders, no
 * vendors, no goods-received notes. A batch is a quantity of one drug with an expiry date, and
 * the only questions it answers are "may this be handed over?" and "which should go first?".
 *
 * ── AND IT IS TENANT-WIDE, LIKE THE MASTER ABOVE IT ─────────────────────────
 * Deliberately, and not by accident of copying: `scopedReads.test.ts` records the medicine
 * master as TENANT-WIDE ("one hospital-wide price/stock list, like `serviceItems`"), and a batch
 * is stock OF a medicine. Movements stay branch-stamped, so the ledger still says which pharmacy
 * did what. Splitting the BALANCE per branch is a real product change — it needs an answer to
 * "how is an existing balance divided?" — and this milestone does not invent one.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

export interface MedicineBatchDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** The site the delivery was booked in at. Recorded, not used as a filter — see the header. */
  branchId?: string;

  medicineId: Types.ObjectId;
  /** Denormalized so a batch can be found by the code a prescription carries, with no join. */
  medicineCode: string;

  /**
   * The manufacturer's batch/lot number. REQUIRED — a batch without one cannot be recalled,
   * which is the other reason this collection exists. Stock received without a batch number
   * stays on the master's running total and out of here, deliberately: an invented batch id
   * would be worse than an honest absence.
   */
  batchNo: string;
  /** REQUIRED. A batch whose expiry is unknown cannot be refused when it lapses. */
  expiry: Date;

  /** Base units received in this lot. Never changes — the audit of what arrived. */
  received: number;
  /** Base units still on the shelf. Only ever moved by a conditional update. */
  remaining: number;

  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new Schema<MedicineBatchDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    medicineId: { type: Schema.Types.ObjectId, required: true },
    medicineCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },

    batchNo: { type: String, required: true, trim: true, maxlength: 80 },
    expiry: { type: Date, required: true },

    received: { type: Number, required: true, min: 1 },
    /**
     * Floored at zero by the schema AND by every query that moves it. Unlike the master's
     * running total — which may legitimately go negative and is reported as `reconcile`, because
     * a counter without a warehouse can hand over stock nobody booked in — a BATCH is a physical
     * box. There cannot be minus three tablets in a box.
     */
    remaining: { type: Number, required: true, min: 0 },
  },
  { timestamps: true, collection: "medicineBatches", autoIndex: false },
);

batchSchema.plugin(tenantScopePlugin);

/**
 * `financial`, matching `stockMovements` rather than the master's `admin`: a batch IS stock the
 * hospital paid for, and who wrote one off and when is exactly what an inspector asks about.
 */
batchSchema.plugin(auditPlugin, { resource: "medicineBatch", category: "financial" });

export function getMedicineBatchModel(connection: Connection): Model<MedicineBatchDoc> {
  return (connection.models.MedicineBatch ??
    connection.model<MedicineBatchDoc>("MedicineBatch", batchSchema)) as Model<MedicineBatchDoc>;
}

/**
 * How close to expiry counts as "going off".
 *
 * Ninety days, and the number is a judgement rather than a discovery: it is long enough that a
 * pharmacy can still use or return the stock, and short enough that the list stays worth reading.
 * A hospital that wants a different window is a configuration change, not a code one — when
 * somebody actually asks for it.
 */
export const NEAR_EXPIRY_DAYS = 90;

export type BatchState = "expired" | "near_expiry" | "ok";

/** `now` is a parameter so this is testable against fixed instants rather than the wall clock. */
export function batchState(expiry: Date, now: Date = new Date()): BatchState {
  if (expiry.getTime() <= now.getTime()) return "expired";
  const days = (expiry.getTime() - now.getTime()) / 86_400_000;
  return days <= NEAR_EXPIRY_DAYS ? "near_expiry" : "ok";
}
