/**
 * Prescription repository — the ONLY code that queries `prescriptions`
 * (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getPrescriptionModel,
  type PrescriptionDoc,
  type PrescriptionHistoryEntry,
  type PrescriptionLine,
  type PrescriptionStatus,
} from "./prescription.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Prescription {
  id: string;
  encounterId: string;
  patientId: string;
  episodeId: string;
  status: PrescriptionStatus;
  lines: PrescriptionLine[];
  prescribedBy: string;
  prescribedAt: Date;
  signedBy?: string;
  signedAt?: Date;
  orderId?: string;
  version: number;
  supersedesId?: string;
  supersededById?: string;
  cancelReason?: string;
  notes?: string;
  safetyOverride?: {
    reason: string;
    by: string;
    at: Date;
    alerts: { kind: string; severity: string; allergen?: string; message: string }[];
  };
  branchId?: string;
  history: PrescriptionHistoryEntry[];
  createdAt: Date;
}

function toPrescription(doc: PrescriptionDoc): Prescription {
  return {
    id: doc._id.toString(),
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    status: doc.status,
    // `dispensedQty` is defaulted in the schema, but a document written before this
    // field existed would arrive without it. Normalising here means no consumer has to
    // guess whether `undefined` means "none yet" or "unknown".
    lines: (doc.lines ?? []).map((l) => ({ ...l, dispensedQty: l.dispensedQty ?? 0 })),
    prescribedBy: doc.prescribedBy,
    prescribedAt: doc.prescribedAt,
    version: doc.version,
    history: doc.history ?? [],
    createdAt: doc.createdAt,
    ...(doc.signedBy ? { signedBy: doc.signedBy } : {}),
    ...(doc.signedAt ? { signedAt: doc.signedAt } : {}),
    ...(doc.orderId ? { orderId: doc.orderId.toString() } : {}),
    ...(doc.supersedesId ? { supersedesId: doc.supersedesId.toString() } : {}),
    ...(doc.supersededById ? { supersededById: doc.supersededById.toString() } : {}),
    ...(doc.cancelReason ? { cancelReason: doc.cancelReason } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.safetyOverride ? { safetyOverride: doc.safetyOverride } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreatePrescriptionInput {
  encounterId: string;
  patientId: string;
  episodeId: string;
  lines: PrescriptionLine[];
  notes?: string;
  branchId?: string;
  version?: number;
  supersedesId?: string;
}

export async function create(
  input: CreatePrescriptionInput,
  session?: ClientSession,
): Promise<Prescription> {
  const ctx = getContext();

  const [doc] = await getPrescriptionModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        encounterId: new Types.ObjectId(input.encounterId),
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        status: "draft",
        lines: input.lines,
        // The prescriber is the authenticated caller. A body that could name the
        // prescriber is a body that could sign a drug out in someone else's name.
        prescribedBy: ctx.userId ?? "system",
        prescribedAt: new Date(),
        version: input.version ?? 1,
        history: [],
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.supersedesId ? { supersedesId: new Types.ObjectId(input.supersedesId) } : {}),
      },
    ],
    session ? { session } : {},
  );

  if (!doc) throw new Error("prescription insert returned nothing");
  return toPrescription(doc);
}

/**
 * Reads one prescription, within the caller's row scope.
 *
 * ── THERE IS NO UNSCOPED VARIANT, AND THAT IS THE POINT ─────────────────────
 * An earlier draft of this module had one, to let a PHARMACIST read a prescription
 * somebody else had written — because `prescription:*` was `own`-scoped and their counter
 * would otherwise have been empty. The bypass was treating the symptom: the real defect
 * was the scope (see `PRESCRIPTION_CREATE` in @medicore/permissions), and once that was
 * `branch` the pharmacist could read it through the ordinary path like everyone else.
 *
 * Which is strictly better than the bypass would have been: a pharmacist restricted to one
 * branch is now correctly unable to dispense another branch's prescriptions, where an
 * unscoped read would have handed them the whole hospital.
 */
export async function findById(id: string): Promise<Prescription | undefined> {
  const doc = await getPrescriptionModel(getTenantDb())
    .findOne({ _id: id, ...scopeFilter("prescribedBy") })
    .lean<PrescriptionDoc>();
  return doc ? toPrescription(doc) : undefined;
}

export async function findByOrderId(orderId: string): Promise<Prescription | undefined> {
  const doc = await getPrescriptionModel(getTenantDb())
    .findOne({ orderId: new Types.ObjectId(orderId) })
    .lean<PrescriptionDoc>();
  return doc ? toPrescription(doc) : undefined;
}

export interface ListPrescriptionsFilter {
  encounterId?: string;
  patientId?: string;
  status?: PrescriptionStatus;
  /** Hide the versions that have been replaced — a chart shows what is in force. */
  currentOnly?: boolean;
  limit: number;
  skip: number;
}

export async function list(
  filter: ListPrescriptionsFilter,
): Promise<{ items: Prescription[]; total: number }> {
  const model = getPrescriptionModel(getTenantDb());

  const query: Record<string, unknown> = {
    ...scopeFilter("prescribedBy"),
    ...(filter.encounterId ? { encounterId: new Types.ObjectId(filter.encounterId) } : {}),
    ...(filter.patientId ? { patientId: new Types.ObjectId(filter.patientId) } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.currentOnly ? { supersededById: { $exists: false } } : {}),
  };

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ prescribedAt: -1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<PrescriptionDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toPrescription), total };
}

/**
 * Replaces the lines of a DRAFT.
 *
 * The `status: "draft"` in the filter is not belt-and-braces on top of the service's
 * check — it is the check that actually holds when two requests race. A guard that reads
 * the status and then writes has a window between the two; this does not.
 */
export async function updateDraftLines(
  id: string,
  lines: PrescriptionLine[],
  notes?: string,
): Promise<Prescription | undefined> {
  const doc = await getPrescriptionModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id, status: "draft" },
      { $set: { lines, ...(notes === undefined ? {} : { notes }) } },
      { new: true },
    )
    .lean<PrescriptionDoc>();

  return doc ? toPrescription(doc) : undefined;
}

/**
 * Moves the prescription, and records who moved it.
 *
 * `from` is in the FILTER, so the transition is compare-and-swap: two pharmacists
 * dispensing the last item at the same instant cannot both drive `signed → dispensed`.
 * The loser gets `undefined` and the service turns that into a retry-able conflict rather
 * than a second handover of the same drugs.
 */
export async function setStatus(
  id: string,
  from: PrescriptionStatus,
  to: PrescriptionStatus,
  entry: PrescriptionHistoryEntry,
  session?: ClientSession,
  alsoSet: Record<string, unknown> = {},
): Promise<Prescription | undefined> {
  const doc = await getPrescriptionModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id, status: from },
      { $set: { status: to, ...alsoSet }, $push: { history: entry } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<PrescriptionDoc>();

  return doc ? toPrescription(doc) : undefined;
}

/** Links the `pharmacy` order raised at signing back to the prescription that raised it. */
export async function setOrderId(
  id: string,
  orderId: string,
  session?: ClientSession,
): Promise<void> {
  await getPrescriptionModel(getTenantDb()).updateOne(
    { _id: id },
    { $set: { orderId: new Types.ObjectId(orderId) } },
    session ? { session } : {},
  );
}

export async function setSupersededBy(id: string, byId: string): Promise<void> {
  await getPrescriptionModel(getTenantDb()).updateOne(
    { _id: id },
    { $set: { supersededById: new Types.ObjectId(byId) } },
  );
}

/**
 * Records what was actually handed over, one line at a time.
 *
 * ── THE GUARD IS IN THE QUERY, NOT IN A PRIOR READ ──────────────────────────
 * `$expr` refuses the update unless the new total still fits inside what was prescribed.
 * A read-then-write here would let two pharmacists both check "8 of 10 dispensed, 2 left",
 * both pass, and both hand over 2 — and the patient walks out with 12 tablets of a drug
 * they were prescribed 10 of. With a controlled substance that is not a billing error,
 * it is a diversion, and the ledger would show it never happened.
 *
 * Returns `undefined` when the quantity does not fit. The service reads that as a refusal,
 * not as a missing document.
 */
export async function addDispensedQty(
  id: string,
  lineIndex: number,
  qty: number,
  session?: ClientSession,
): Promise<Prescription | undefined> {
  const model = getPrescriptionModel(getTenantDb());

  /**
   * ── `$arrayElemAt`, NOT `$lines.0.dispensedQty` ─────────────────────────────
   * Inside an aggregation expression a dotted path across an array does NOT index into
   * it: `$lines.dispensedQty` evaluates to an ARRAY of every line's value, and the `0` in
   * `$lines.0.dispensedQty` is read as a field name, not a subscript. The obvious spelling
   * therefore fed an array to `$add` and the whole update failed with a type error.
   *
   * It failed CLOSED — nothing was dispensed — so it was a broken counter rather than an
   * over-dispense. That is luck, not design, and it is exactly why this guard has a test
   * that dispenses one tablet too many and expects to be refused (`prescriptions.int.test.ts`).
   */
  const dispensedSoFar = { $ifNull: [{ $arrayElemAt: ["$lines.dispensedQty", lineIndex] }, 0] };
  const prescribed = { $arrayElemAt: ["$lines.quantity", lineIndex] };

  const doc = await model
    .findOneAndUpdate(
      {
        _id: id,
        $expr: { $lte: [{ $add: [dispensedSoFar, qty] }, prescribed] },
      },
      { $inc: { [`lines.${String(lineIndex)}.dispensedQty`]: qty } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<PrescriptionDoc>();

  return doc ? toPrescription(doc) : undefined;
}
