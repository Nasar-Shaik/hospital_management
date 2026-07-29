/**
 * Consent repository — the ONLY code that queries `consents` (Constitution §6). PHI, read
 * branch-aware; a consent taken at one branch is that branch's record.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getConsentModel,
  type ConsentDoc,
  type ConsentType,
  type ConsentSigner,
  type ConsentStatus,
} from "./consent.model.js";

export interface Consent {
  id: string;
  patientId: string;
  encounterId?: string;
  type: ConsentType;
  procedure: string;
  risksExplained?: string;
  signedBy: ConsentSigner;
  signerName: string;
  relationship?: string;
  language?: string;
  witnessName?: string;
  explainedBy?: string;
  signedAt: string;
  status: ConsentStatus;
  withdrawnAt?: string;
  withdrawalReason?: string;
  createdAt: string;
}

function toConsent(doc: ConsentDoc): Consent {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    type: doc.type,
    procedure: doc.procedure,
    ...(doc.risksExplained ? { risksExplained: doc.risksExplained } : {}),
    signedBy: doc.signedBy,
    signerName: doc.signerName,
    ...(doc.relationship ? { relationship: doc.relationship } : {}),
    ...(doc.language ? { language: doc.language } : {}),
    ...(doc.witnessName ? { witnessName: doc.witnessName } : {}),
    ...(doc.explainedBy ? { explainedBy: doc.explainedBy } : {}),
    signedAt: doc.signedAt.toISOString(),
    status: doc.status,
    ...(doc.withdrawnAt ? { withdrawnAt: doc.withdrawnAt.toISOString() } : {}),
    ...(doc.withdrawalReason ? { withdrawalReason: doc.withdrawalReason } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

export interface CreateConsentInput {
  patientId: string;
  encounterId?: string;
  type: ConsentType;
  procedure: string;
  risksExplained?: string;
  signedBy: ConsentSigner;
  signerName: string;
  relationship?: string;
  language?: string;
  witnessName?: string;
  signedAt: Date;
}

export async function create(input: CreateConsentInput): Promise<Consent> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getConsentModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: new Types.ObjectId(input.patientId),
    ...(input.encounterId ? { encounterId: new Types.ObjectId(input.encounterId) } : {}),
    type: input.type,
    procedure: input.procedure,
    ...(input.risksExplained ? { risksExplained: input.risksExplained } : {}),
    signedBy: input.signedBy,
    signerName: input.signerName,
    ...(input.relationship ? { relationship: input.relationship } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.witnessName ? { witnessName: input.witnessName } : {}),
    signedAt: input.signedAt,
    status: "active",
    ...(ctx.userId ? { explainedBy: ctx.userId, createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toConsent(doc.toObject() as ConsentDoc);
}

export async function listForPatient(patientId: string): Promise<Consent[]> {
  const docs = await getConsentModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId), ...scopeFilter() })
    .sort({ signedAt: -1 })
    .lean<ConsentDoc[]>();
  return docs.map(toConsent);
}

export async function findById(id: string): Promise<Consent | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getConsentModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<ConsentDoc>();
  return doc ? toConsent(doc) : undefined;
}

export async function withdraw(id: string, reason: string): Promise<Consent | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getConsentModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: "active", ...scopeFilter() },
      { $set: { status: "withdrawn", withdrawnAt: new Date(), withdrawalReason: reason } },
      { new: true },
    )
    .lean<ConsentDoc>();
  return doc ? toConsent(doc) : undefined;
}
