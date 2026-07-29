/**
 * Death record repository — the ONLY code that queries `deathRecords` (Constitution §6). PHI,
 * read branch-aware. One record per encounter (the unique index in migration 0042).
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getDeathRecordModel,
  type DeathRecordDoc,
  type MannerOfDeath,
} from "./deathRecord.model.js";

export { isDuplicateKey };

export interface DeathRecord {
  id: string;
  patientId: string;
  encounterId: string;
  diedAt: string;
  pronouncedAt?: string;
  immediateCause: string;
  antecedentCause?: string;
  underlyingCause?: string;
  contributingConditions?: string;
  manner: MannerOfDeath;
  medicoLegal: boolean;
  postmortemRequired: boolean;
  certifiedBy?: string;
  bodyHandedTo?: string;
  bodyHandedRelationship?: string;
  remarks?: string;
  createdAt: string;
}

function toRecord(doc: DeathRecordDoc): DeathRecord {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    encounterId: doc.encounterId.toString(),
    diedAt: doc.diedAt.toISOString(),
    ...(doc.pronouncedAt ? { pronouncedAt: doc.pronouncedAt.toISOString() } : {}),
    immediateCause: doc.immediateCause,
    ...(doc.antecedentCause ? { antecedentCause: doc.antecedentCause } : {}),
    ...(doc.underlyingCause ? { underlyingCause: doc.underlyingCause } : {}),
    ...(doc.contributingConditions ? { contributingConditions: doc.contributingConditions } : {}),
    manner: doc.manner,
    medicoLegal: doc.medicoLegal,
    postmortemRequired: doc.postmortemRequired,
    ...(doc.certifiedBy ? { certifiedBy: doc.certifiedBy } : {}),
    ...(doc.bodyHandedTo ? { bodyHandedTo: doc.bodyHandedTo } : {}),
    ...(doc.bodyHandedRelationship ? { bodyHandedRelationship: doc.bodyHandedRelationship } : {}),
    ...(doc.remarks ? { remarks: doc.remarks } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

export interface CreateDeathRecordInput {
  patientId: string;
  encounterId: string;
  diedAt: Date;
  pronouncedAt?: Date;
  immediateCause: string;
  antecedentCause?: string;
  underlyingCause?: string;
  contributingConditions?: string;
  manner: MannerOfDeath;
  medicoLegal: boolean;
  postmortemRequired: boolean;
  bodyHandedTo?: string;
  bodyHandedRelationship?: string;
  remarks?: string;
}

export async function create(input: CreateDeathRecordInput): Promise<DeathRecord> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getDeathRecordModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: new Types.ObjectId(input.patientId),
    encounterId: new Types.ObjectId(input.encounterId),
    diedAt: input.diedAt,
    ...(input.pronouncedAt ? { pronouncedAt: input.pronouncedAt } : {}),
    immediateCause: input.immediateCause,
    ...(input.antecedentCause ? { antecedentCause: input.antecedentCause } : {}),
    ...(input.underlyingCause ? { underlyingCause: input.underlyingCause } : {}),
    ...(input.contributingConditions
      ? { contributingConditions: input.contributingConditions }
      : {}),
    manner: input.manner,
    medicoLegal: input.medicoLegal,
    postmortemRequired: input.postmortemRequired,
    ...(input.bodyHandedTo ? { bodyHandedTo: input.bodyHandedTo } : {}),
    ...(input.bodyHandedRelationship
      ? { bodyHandedRelationship: input.bodyHandedRelationship }
      : {}),
    ...(input.remarks ? { remarks: input.remarks } : {}),
    ...(ctx.userId ? { certifiedBy: ctx.userId, createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toRecord(doc.toObject() as DeathRecordDoc);
}

export async function findForEncounter(encounterId: string): Promise<DeathRecord | undefined> {
  if (!Types.ObjectId.isValid(encounterId)) return undefined;
  const doc = await getDeathRecordModel(getTenantDb())
    .findOne({ encounterId: new Types.ObjectId(encounterId), ...scopeFilter() })
    .lean<DeathRecordDoc>();
  return doc ? toRecord(doc) : undefined;
}

export async function findForPatient(patientId: string): Promise<DeathRecord | undefined> {
  const doc = await getDeathRecordModel(getTenantDb())
    .findOne({ patientId: new Types.ObjectId(patientId), ...scopeFilter() })
    .sort({ diedAt: -1 })
    .lean<DeathRecordDoc>();
  return doc ? toRecord(doc) : undefined;
}
