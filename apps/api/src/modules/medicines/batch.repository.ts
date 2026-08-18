/**
 * Batch reads and writes — the ONLY code that queries `medicineBatches` (Constitution §6).
 */
import { Types, type ClientSession } from "mongoose";
import { getTenantDb, getContext } from "../../core/context/requestContext.js";
import { getMedicineBatchModel, type MedicineBatchDoc } from "./batch.model.js";

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface MedicineBatch {
  id: string;
  medicineId: string;
  medicineCode: string;
  batchNo: string;
  expiry: Date;
  received: number;
  remaining: number;
  branchId?: string;
  createdAt: Date;
}

function toBatch(doc: MedicineBatchDoc): MedicineBatch {
  return {
    id: doc._id.toString(),
    medicineId: doc.medicineId.toString(),
    medicineCode: doc.medicineCode,
    batchNo: doc.batchNo,
    expiry: doc.expiry,
    received: doc.received,
    remaining: doc.remaining,
    createdAt: doc.createdAt,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface ReceiveBatchInput {
  medicineId: string;
  medicineCode: string;
  batchNo: string;
  expiry: Date;
  quantity: number;
  branchId?: string;
}

/**
 * Books a delivery in.
 *
 * ── AN UPSERT, SO A REPEATED DELIVERY TOPS UP RATHER THAN DUPLICATING ───────
 * The same batch of the same drug can arrive twice — a split delivery, or the rest of an order
 * that came short. Two rows for one physical box would let FEFO hand the same tablets out twice
 * and would make a recall miss half of them. `one_row_per_batch` is what arbitrates that, not a
 * read-then-write: two clerks booking the same delivery at once both take this path, and the
 * database decides which one inserts and which one increments.
 */
export async function receiveBatch(
  input: ReceiveBatchInput,
  session?: ClientSession,
): Promise<MedicineBatch> {
  const ctx = getContext();
  const doc = await getMedicineBatchModel(getTenantDb()).findOneAndUpdate(
    {
      tenantId: ctx.tenantId,
      medicineCode: input.medicineCode,
      batchNo: input.batchNo,
      expiry: input.expiry,
    },
    {
      $inc: { received: input.quantity, remaining: input.quantity },
      $setOnInsert: {
        tenantId: ctx.tenantId,
        medicineId: new Types.ObjectId(input.medicineId),
        medicineCode: input.medicineCode,
        batchNo: input.batchNo,
        expiry: input.expiry,
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
    },
    { new: true, upsert: true, ...(session ? { session } : {}) },
  );

  return toBatch(doc);
}

/**
 * The lots this drug could be handed over FROM, earliest expiry first.
 *
 * ── EXPIRED LOTS ARE NOT LISTED, THEY ARE EXCLUDED ──────────────────────────
 * `expiry > now` is in the QUERY rather than filtered afterwards, so there is no path through
 * this function that can return an expired lot to a caller who forgot to check. The one place
 * that wants them — the pharmacist's own shelf view, which must show what to pull and destroy —
 * asks for them explicitly through `listForMedicine`.
 */
export async function allocatableFor(
  medicineCode: string,
  now: Date,
  session?: ClientSession,
): Promise<MedicineBatch[]> {
  const query = getMedicineBatchModel(getTenantDb())
    .find({ medicineCode, remaining: { $gt: 0 }, expiry: { $gt: now } })
    .sort({ expiry: 1 });
  if (session) query.session(session);
  const docs = await query.lean<MedicineBatchDoc[]>();
  return docs.map(toBatch);
}

/**
 * Takes `quantity` off ONE lot, or takes nothing.
 *
 * ── THE GUARD IS THE QUERY ──────────────────────────────────────────────────
 * `remaining: { $gte: quantity }` is the whole of the concurrency control. Two pharmacists
 * reaching for the same last twenty tablets both arrive here; the database lets one through and
 * answers the other with nothing, and the caller moves to the next lot. A read-then-write would
 * let both see twenty, both pass, and both hand them over — the box would be empty and the
 * records would say it was not.
 *
 * `expiry` is re-checked here as well as in the listing above. The list and the take are two
 * round trips, and a batch that lapses between them must not be handed over because a query a
 * moment ago said it was fine.
 */
export async function takeFromBatch(
  batchId: string,
  quantity: number,
  now: Date,
  session?: ClientSession,
): Promise<MedicineBatch | undefined> {
  const doc = await getMedicineBatchModel(getTenantDb()).findOneAndUpdate(
    { _id: new Types.ObjectId(batchId), remaining: { $gte: quantity }, expiry: { $gt: now } },
    { $inc: { remaining: -quantity } },
    { new: true, ...(session ? { session } : {}) },
  );
  return doc ? toBatch(doc) : undefined;
}

/** Puts stock back on a lot — the reversal half of an adjustment, and a write-off's opposite. */
export async function returnToBatch(
  batchId: string,
  quantity: number,
  session?: ClientSession,
): Promise<MedicineBatch | undefined> {
  const doc = await getMedicineBatchModel(getTenantDb()).findOneAndUpdate(
    { _id: new Types.ObjectId(batchId) },
    { $inc: { remaining: quantity } },
    { new: true, ...(session ? { session } : {}) },
  );
  return doc ? toBatch(doc) : undefined;
}

/** Every lot of one drug, expired ones included — the shelf, as a pharmacist has to see it. */
export async function listForMedicine(medicineCode: string): Promise<MedicineBatch[]> {
  const docs = await getMedicineBatchModel(getTenantDb())
    .find({ medicineCode })
    .sort({ expiry: 1 })
    .lean<MedicineBatchDoc[]>();
  return docs.map(toBatch);
}

/** One lot by id, for an explicit pick or a write-off. */
export async function findById(id: string): Promise<MedicineBatch | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getMedicineBatchModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<MedicineBatchDoc>();
  return doc ? toBatch(doc) : undefined;
}

/**
 * Batched stock on hand per drug, for the availability the prescribing screen shows.
 *
 * Expired lots are excluded — a doctor asking "does the pharmacy have this?" is asking what can
 * actually be handed to their patient, and counting stock that may not be dispensed would be a
 * worse answer than zero.
 */
export async function onHandByCode(
  codes: string[],
  now: Date,
): Promise<Map<string, { units: number; nearestExpiry?: Date }>> {
  if (codes.length === 0) return new Map();

  const rows = await getMedicineBatchModel(getTenantDb()).aggregate<{
    _id: string;
    units: number;
    nearestExpiry: Date;
  }>([
    { $match: { medicineCode: { $in: codes }, remaining: { $gt: 0 }, expiry: { $gt: now } } },
    {
      $group: {
        _id: "$medicineCode",
        units: { $sum: "$remaining" },
        nearestExpiry: { $min: "$expiry" },
      },
    },
  ]);

  return new Map(rows.map((r) => [r._id, { units: r.units, nearestExpiry: r.nearestExpiry }]));
}
