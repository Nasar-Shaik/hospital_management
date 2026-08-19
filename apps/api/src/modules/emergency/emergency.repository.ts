/**
 * ED triage repository — the ONLY code that queries `edTriage` (Constitution §6).
 *
 * Branch-aware like every other clinical collection: reads pass through `scopeFilter()` and writes
 * stamp the active branch. The BOARD is assembled in the service, because it joins three modules'
 * worth of facts (the encounter, the patient, this record) and a repository owns one collection.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { getEdTriageModel, type EdTriageDoc, type TriagePriority } from "./emergency.model.js";

export interface Triage {
  encounterId: string;
  patientId: string;
  /** Absent until somebody has assessed the patient — see the model. */
  priority?: TriagePriority;
  chiefComplaint?: string;
  triagedAt?: string;
  triagedBy?: string;
  transferredTo?: string;
  transferNote?: string;
  transferredAt?: string;
}

function toTriage(doc: EdTriageDoc): Triage {
  return {
    encounterId: doc.encounterId.toString(),
    patientId: doc.patientId.toString(),
    ...(doc.priority ? { priority: doc.priority } : {}),
    ...(doc.chiefComplaint ? { chiefComplaint: doc.chiefComplaint } : {}),
    ...(doc.triagedAt ? { triagedAt: doc.triagedAt.toISOString() } : {}),
    ...(doc.triagedBy ? { triagedBy: doc.triagedBy } : {}),
    ...(doc.transferredTo ? { transferredTo: doc.transferredTo } : {}),
    ...(doc.transferNote ? { transferNote: doc.transferNote } : {}),
    ...(doc.transferredAt ? { transferredAt: doc.transferredAt.toISOString() } : {}),
  };
}

export interface RecordTriageInput {
  encounterId: string;
  patientId: string;
  priority: TriagePriority;
  chiefComplaint?: string;
  triagedBy?: string;
}

/**
 * Records — or REVISES — the triage judgement on an ED visit.
 *
 * An upsert, because re-triage is the ordinary case and not an error: a patient who has been
 * waiting deteriorates, and a nurse who cannot say so has to work around the product. `upsert` on
 * the unique `{tenantId, encounterId}` key also makes a double-submit safe — the second write lands
 * on the same row rather than creating a second, contradictory priority for one patient.
 */
export async function recordTriage(input: RecordTriageInput): Promise<Triage> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getEdTriageModel(getTenantDb())
    .findOneAndUpdate(
      { tenantId: ctx.tenantId, encounterId: new Types.ObjectId(input.encounterId) },
      {
        $set: {
          patientId: new Types.ObjectId(input.patientId),
          priority: input.priority,
          triagedAt: new Date(),
          ...(input.chiefComplaint ? { chiefComplaint: input.chiefComplaint } : {}),
          ...(input.triagedBy ? { triagedBy: input.triagedBy } : {}),
          ...(branchId ? { branchId } : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    .lean<EdTriageDoc>();
  return toTriage(doc);
}

/**
 * Every triage record for a set of encounters — one query for the whole board.
 *
 * ── AN HONEST NOTE ABOUT `scopeFilter()` HERE ───────────────────────────────
 * It is a SECOND lock, and deliberately not the one that matters. The only caller passes ids that
 * came back from `listEncounters`, which is already branch- and tenant-scoped, so a record this
 * read could return is by construction one the caller may already see. Deleting the filter turns
 * no test red — that was checked, not assumed — and it stays because the day something else calls
 * this with ids from elsewhere, the read should not be the thing that has to be remembered.
 *
 * The scoping the board actually depends on is proved in `emergency.int.test.ts` ("one site's
 * department is not another's"), and removing it from `encounter.repository.ts` turns that red.
 */
export async function findByEncounters(encounterIds: string[]): Promise<Triage[]> {
  const ids = encounterIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return [];
  const docs = await getEdTriageModel(getTenantDb())
    .find({ encounterId: { $in: ids }, ...scopeFilter() })
    .lean<EdTriageDoc[]>();
  return docs.map(toTriage);
}

export interface TransferInput {
  encounterId: string;
  patientId: string;
  destination: string;
  note?: string;
  by?: string;
}

/**
 * Records that the patient left for another facility.
 *
 * Upserted for the same reason as the triage itself: a patient can be transferred out before
 * anybody found time to triage them — a crash victim who needs a trauma centre is diverted on
 * sight — and refusing to record the transfer because the paperwork ran out of order would lose
 * the only fact anyone will later need.
 */
export async function recordTransfer(input: TransferInput): Promise<Triage> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getEdTriageModel(getTenantDb())
    .findOneAndUpdate(
      { tenantId: ctx.tenantId, encounterId: new Types.ObjectId(input.encounterId) },
      {
        $set: {
          patientId: new Types.ObjectId(input.patientId),
          transferredTo: input.destination,
          transferredAt: new Date(),
          ...(input.note ? { transferNote: input.note } : {}),
          ...(input.by ? { transferredBy: input.by } : {}),
          ...(branchId ? { branchId } : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    .lean<EdTriageDoc>();
  return toTriage(doc);
}
