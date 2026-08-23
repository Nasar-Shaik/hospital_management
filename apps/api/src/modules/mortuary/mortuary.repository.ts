/**
 * Mortuary repository — the ONLY code that queries `mortuaryRegister` (Constitution §6). PHI,
 * read branch-aware. One entry per encounter (the unique index in migration 0045).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getMortuaryEntryModel,
  type MortuaryEntryDoc,
  type MortuaryStatus,
} from "./mortuary.model.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";

export { isDuplicateKey };

export interface MortuaryEntry {
  id: string;
  patientId: string;
  encounterId: string;
  deathRecordId?: string;
  deceasedName: string;
  receivedAt: string;
  receivedBy?: string;
  tagNumber: string;
  storageUnit?: string;
  medicoLegal: boolean;
  status: MortuaryStatus;
  releasedAt?: string;
  releasedBy?: string;
  releasedTo?: string;
  releasedRelationship?: string;
  clearanceRef?: string;
  remarks?: string;
  createdAt: string;
}

function toEntry(d: MortuaryEntryDoc): MortuaryEntry {
  return {
    id: d._id.toString(),
    patientId: d.patientId.toString(),
    encounterId: d.encounterId.toString(),
    ...(d.deathRecordId ? { deathRecordId: d.deathRecordId.toString() } : {}),
    deceasedName: d.deceasedName,
    receivedAt: d.receivedAt.toISOString(),
    ...(d.receivedBy ? { receivedBy: d.receivedBy } : {}),
    tagNumber: d.tagNumber,
    ...(d.storageUnit ? { storageUnit: d.storageUnit } : {}),
    medicoLegal: d.medicoLegal,
    status: d.status,
    ...(d.releasedAt ? { releasedAt: d.releasedAt.toISOString() } : {}),
    ...(d.releasedBy ? { releasedBy: d.releasedBy } : {}),
    ...(d.releasedTo ? { releasedTo: d.releasedTo } : {}),
    ...(d.releasedRelationship ? { releasedRelationship: d.releasedRelationship } : {}),
    ...(d.clearanceRef ? { clearanceRef: d.clearanceRef } : {}),
    ...(d.remarks ? { remarks: d.remarks } : {}),
    createdAt: d.createdAt.toISOString(),
  };
}

export interface CreateEntryInput {
  patientId: string;
  encounterId: string;
  deathRecordId?: string;
  deceasedName: string;
  tagNumber: string;
  storageUnit?: string;
  medicoLegal: boolean;
  remarks?: string;
}

export async function create(input: CreateEntryInput): Promise<MortuaryEntry> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getMortuaryEntryModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: new Types.ObjectId(input.patientId),
    encounterId: new Types.ObjectId(input.encounterId),
    ...(input.deathRecordId ? { deathRecordId: new Types.ObjectId(input.deathRecordId) } : {}),
    deceasedName: input.deceasedName,
    receivedAt: new Date(),
    tagNumber: input.tagNumber,
    ...(input.storageUnit ? { storageUnit: input.storageUnit } : {}),
    medicoLegal: input.medicoLegal,
    status: "in_storage",
    ...(input.remarks ? { remarks: input.remarks } : {}),
    ...(ctx.userId ? { receivedBy: ctx.userId, createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toEntry(doc.toObject() as MortuaryEntryDoc);
}

export async function findById(id: string): Promise<MortuaryEntry | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getMortuaryEntryModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<MortuaryEntryDoc>();
  return doc ? toEntry(doc) : undefined;
}

export async function findForEncounter(encounterId: string): Promise<MortuaryEntry | undefined> {
  if (!Types.ObjectId.isValid(encounterId)) return undefined;
  const doc = await getMortuaryEntryModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), ...scopeFilter() })
    .lean<MortuaryEntryDoc>();
  return doc ? toEntry(doc) : undefined;
}

/** The register, newest first — the occupancy board when filtered to `in_storage`. */
export async function list(status?: MortuaryStatus): Promise<MortuaryEntry[]> {
  const q: Record<string, unknown> = { ...scopeFilter() };
  if (status) q.status = status;
  const docs = await getMortuaryEntryModel(getTenantDb())
    .find(q)
    .sort({ receivedAt: -1 })
    .limit(500)
    .lean<MortuaryEntryDoc[]>();
  return docs.map(toEntry);
}

export interface ReleaseInput {
  releasedTo: string;
  releasedRelationship: string;
  clearanceRef?: string;
  remarks?: string;
}

/**
 * Release a stored body. Only touches an `in_storage` entry — the status guard in the filter makes
 * a double-release a no-op the service reads as "already released", never a silent second update.
 */
export async function release(id: string, input: ReleaseInput): Promise<MortuaryEntry | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const ctx = getContext();
  const doc = await getMortuaryEntryModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: "in_storage", ...scopeFilter() },
      {
        $set: {
          status: "released",
          releasedAt: new Date(),
          releasedTo: input.releasedTo,
          releasedRelationship: input.releasedRelationship,
          ...(input.clearanceRef ? { clearanceRef: input.clearanceRef } : {}),
          ...(input.remarks ? { remarks: input.remarks } : {}),
          ...(ctx.userId ? { releasedBy: ctx.userId } : {}),
        },
      },
      { new: true },
    )
    .lean<MortuaryEntryDoc>();
  return doc ? toEntry(doc) : undefined;
}

/**
 * The mortuary register follows the person, for the reason above it: release refuses a
 * medico-legal body without a clearance reference, and the entry carries the snapshot of that flag.
 * An entry orphaned on a retired chart is a body whose custody the surviving record cannot account
 * for.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getMortuaryEntryModel(getTenantDb()), "patientId", ref, {
    objectId: true,
  });
}
