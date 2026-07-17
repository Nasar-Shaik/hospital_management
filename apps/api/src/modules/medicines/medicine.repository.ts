/**
 * Medicine + stock repository — the ONLY code that queries `medicines` and `stockMovements`
 * (Constitution §6).
 *
 * ── THE ONE INVARIANT THIS FILE EXISTS TO KEEP ──────────────────────────────
 * A stock movement and the balance it produces are written TOGETHER, in a transaction, so the
 * mirrored `stockUnits` on the master can never disagree with the ledger that explains it. The
 * balance is computed by an atomic `$inc` and read back, then stamped onto the movement — so
 * two concurrent receipts cannot both read "40", add ten, and both write "50".
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getMedicineModel,
  getStockMovementModel,
  type MedicineDoc,
  type MedicineForm,
  type StockMovementDoc,
  type StockMovementKind,
} from "./medicine.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Medicine {
  id: string;
  code: string;
  name: string;
  manufacturer?: string;
  generic?: string;
  form: MedicineForm;
  strength?: string;
  unitsPerSheet?: number;
  sheetsPerPack?: number;
  stockUnits: number;
  reorderLevel: number;
  active: boolean;
  branchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockMovement {
  id: string;
  medicineId: string;
  medicineCode: string;
  kind: StockMovementKind;
  delta: number;
  balanceAfter: number;
  batchNo?: string;
  expiry?: Date;
  reason?: string;
  dispenseId?: string;
  createdBy: string;
  createdAt: Date;
}

function toMedicine(d: MedicineDoc): Medicine {
  return {
    id: d._id.toString(),
    code: d.code,
    name: d.name,
    form: d.form,
    stockUnits: d.stockUnits,
    reorderLevel: d.reorderLevel,
    active: d.active,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
    ...(d.generic ? { generic: d.generic } : {}),
    ...(d.strength ? { strength: d.strength } : {}),
    ...(d.unitsPerSheet !== undefined ? { unitsPerSheet: d.unitsPerSheet } : {}),
    ...(d.sheetsPerPack !== undefined ? { sheetsPerPack: d.sheetsPerPack } : {}),
    ...(d.branchId ? { branchId: d.branchId } : {}),
  };
}

function toMovement(d: StockMovementDoc): StockMovement {
  return {
    id: d._id.toString(),
    medicineId: d.medicineId.toString(),
    medicineCode: d.medicineCode,
    kind: d.kind,
    delta: d.delta,
    balanceAfter: d.balanceAfter,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    ...(d.batchNo ? { batchNo: d.batchNo } : {}),
    ...(d.expiry ? { expiry: d.expiry } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.dispenseId ? { dispenseId: d.dispenseId.toString() } : {}),
  };
}

export interface CreateMedicineInput {
  code: string;
  name: string;
  manufacturer?: string;
  generic?: string;
  form: MedicineForm;
  strength?: string;
  unitsPerSheet?: number;
  sheetsPerPack?: number;
  reorderLevel?: number;
  branchId?: string;
}

/**
 * Adds a medicine to the master. Starts at zero stock — nothing is on the shelf until a
 * receipt says so. Throws a duplicate-key error when the code already exists for this tenant
 * (migration 0019); the service turns that into a clear "code already used" message.
 */
export async function create(input: CreateMedicineInput): Promise<Medicine> {
  const ctx = getContext();
  const doc = await getMedicineModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code,
    name: input.name,
    form: input.form,
    stockUnits: 0,
    reorderLevel: input.reorderLevel ?? 0,
    active: true,
    ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
    ...(input.generic ? { generic: input.generic } : {}),
    ...(input.strength ? { strength: input.strength } : {}),
    ...(input.unitsPerSheet !== undefined ? { unitsPerSheet: input.unitsPerSheet } : {}),
    ...(input.sheetsPerPack !== undefined ? { sheetsPerPack: input.sheetsPerPack } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
  });
  return toMedicine(doc.toObject() as MedicineDoc);
}

/** The descriptive fields a pharmacist may edit. NOT `stockUnits` — that moves via the ledger. */
export interface UpdateMedicineInput {
  name?: string;
  manufacturer?: string;
  generic?: string;
  form?: MedicineForm;
  strength?: string;
  unitsPerSheet?: number;
  sheetsPerPack?: number;
  reorderLevel?: number;
  active?: boolean;
}

export async function update(
  id: string,
  patch: UpdateMedicineInput,
): Promise<Medicine | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getMedicineModel(getTenantDb())
    .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true })
    .lean<MedicineDoc>();
  return doc ? toMedicine(doc) : undefined;
}

export interface ListFilter {
  /** Case-insensitive match over code, name and generic. */
  search?: string;
  /** Only medicines at or below their reorder level (and with a level set). */
  lowStockOnly?: boolean;
  /** Include retired medicines. Off by default — the list is what the pharmacy stocks now. */
  includeInactive?: boolean;
}

export async function list(filter: ListFilter = {}): Promise<Medicine[]> {
  const query: Record<string, unknown> = {};
  if (!filter.includeInactive) query.active = true;
  if (filter.search) {
    const rx = new RegExp(escapeRegExp(filter.search), "i");
    query.$or = [{ code: rx }, { name: rx }, { generic: rx }];
  }
  if (filter.lowStockOnly) {
    // At or below a POSITIVE reorder level. A zero level means "no alert", so it is excluded.
    query.reorderLevel = { $gt: 0 };
    query.$expr = { $lte: ["$stockUnits", "$reorderLevel"] };
  }
  const docs = await getMedicineModel(getTenantDb())
    .find(query)
    .sort({ name: 1 })
    .lean<MedicineDoc[]>();
  return docs.map(toMedicine);
}

export async function findById(id: string): Promise<Medicine | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getMedicineModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<MedicineDoc>();
  return doc ? toMedicine(doc) : undefined;
}

export async function findByCode(code: string): Promise<Medicine | undefined> {
  const doc = await getMedicineModel(getTenantDb())
    .findOne({ code: code.toUpperCase() })
    .lean<MedicineDoc>();
  return doc ? toMedicine(doc) : undefined;
}

export interface MoveStockInput {
  kind: StockMovementKind;
  /** Signed base units: positive in, negative out. */
  delta: number;
  batchNo?: string;
  expiry?: Date;
  reason?: string;
  dispenseId?: string;
  branchId?: string;
}

/**
 * Moves stock and records WHY, atomically.
 *
 * The `$inc` is the concurrency-safe part: it reads-modifies-writes the balance inside the
 * database, so parallel receipts cannot lose each other's units. The returned balance is then
 * stamped onto the ledger row, in the same transaction, so the movement always carries the
 * true running total. Returns the medicine's new balance, or undefined if the id is unknown.
 */
export async function move(
  medicineId: string,
  input: MoveStockInput,
  session?: ClientSession,
): Promise<{ medicine: Medicine; movement: StockMovement } | undefined> {
  if (!Types.ObjectId.isValid(medicineId)) return undefined;
  const ctx = getContext();
  const db = getTenantDb();

  const updated = await getMedicineModel(db)
    .findByIdAndUpdate(
      new Types.ObjectId(medicineId),
      { $inc: { stockUnits: input.delta } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<MedicineDoc>();
  if (!updated) return undefined;

  const [row] = await getStockMovementModel(db).create(
    [
      {
        tenantId: ctx.tenantId,
        medicineId: updated._id,
        medicineCode: updated.code,
        kind: input.kind,
        delta: input.delta,
        balanceAfter: updated.stockUnits,
        createdBy: ctx.userId ?? "system",
        createdAt: new Date(),
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
        ...(input.expiry ? { expiry: input.expiry } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.dispenseId ? { dispenseId: new Types.ObjectId(input.dispenseId) } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    ],
    session ? { session } : {},
  );
  if (!row) throw new Error("stock movement insert returned nothing");

  return { medicine: toMedicine(updated), movement: toMovement(row) };
}

/** One drug's line in the stock register — what an auditor reconciles a month against. */
export interface StockRegisterRow {
  medicineId: string;
  code: string;
  name: string;
  /** Balance the period opened with (every movement strictly before `from`). */
  opening: number;
  /** Units booked IN during the period. */
  received: number;
  /** Units handed OUT during the period, as a positive number. */
  dispensed: number;
  /** Net of corrections during the period — signed. */
  adjusted: number;
  /** Balance the period closed with: opening + received − dispensed + adjusted. */
  closing: number;
}

/**
 * The stock register for a period — per drug: opening, received, dispensed, adjusted, closing.
 *
 * The whole point is that it RECONCILES: closing = opening + received − dispensed + adjusted, for
 * every row, because all four come from the one ledger. `opening` is every movement strictly
 * before the period; the three in-period figures are split by `kind`. The aggregation is tenant-
 * scoped automatically (the model's `pre("aggregate")` hook prepends the tenant `$match`).
 *
 * The range is HALF-OPEN `[from, to)`: a movement at the very last millisecond of the period must
 * not fall through the gap between "period" and "opening of the next" — the same convention the
 * encounter register uses, for the same reason. Every medicine that had any movement in or before
 * the period appears, retired ones included — an auditor reconciles what moved, not only what is
 * on the shelf today.
 */
export async function stockRegister(from: Date, to: Date): Promise<StockRegisterRow[]> {
  const inPeriod = (extra: Record<string, unknown>) => ({
    $and: [{ $gte: ["$createdAt", from] }, { $lt: ["$createdAt", to] }, extra],
  });
  const rows = await getStockMovementModel(getTenantDb()).aggregate<{
    _id: Types.ObjectId;
    opening: number;
    received: number;
    dispensedDelta: number;
    adjusted: number;
  }>([
    {
      $group: {
        _id: "$medicineId",
        opening: { $sum: { $cond: [{ $lt: ["$createdAt", from] }, "$delta", 0] } },
        received: {
          $sum: { $cond: [inPeriod({ $eq: ["$kind", "receipt"] }), "$delta", 0] },
        },
        // Dispense deltas are stored negative; kept signed here and flipped to a positive "out".
        dispensedDelta: {
          $sum: { $cond: [inPeriod({ $eq: ["$kind", "dispense"] }), "$delta", 0] },
        },
        adjusted: {
          $sum: { $cond: [inPeriod({ $eq: ["$kind", "adjustment"] }), "$delta", 0] },
        },
      },
    },
  ]);

  const byId = new Map(rows.map((r) => [r._id.toString(), r]));
  const medicines = await list({ includeInactive: true });
  return (
    medicines
      .map((m) => {
        const r = byId.get(m.id);
        const opening = r?.opening ?? 0;
        const received = r?.received ?? 0;
        const dispensed = r ? -r.dispensedDelta : 0;
        const adjusted = r?.adjusted ?? 0;
        return {
          medicineId: m.id,
          code: m.code,
          name: m.name,
          opening,
          received,
          dispensed,
          adjusted,
          closing: opening + received - dispensed + adjusted,
        };
      })
      // A drug with no opening balance and no movement in the period is not part of this register.
      .filter((r) => r.opening !== 0 || r.received !== 0 || r.dispensed !== 0 || r.adjusted !== 0)
  );
}

/** The movement history for one medicine, newest first — the "how did we get to 42" view. */
export async function listMovements(medicineId: string, limit = 100): Promise<StockMovement[]> {
  if (!Types.ObjectId.isValid(medicineId)) return [];
  const docs = await getStockMovementModel(getTenantDb())
    .find({ medicineId: new Types.ObjectId(medicineId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<StockMovementDoc[]>();
  return docs.map(toMovement);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
