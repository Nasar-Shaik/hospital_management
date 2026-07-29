/**
 * Insurance repository — the ONLY code that queries `insurancePolicies` / `insuranceClaims`
 * (Constitution §6). Branch-aware like every operational collection.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getInsurancePolicyModel,
  getInsuranceClaimModel,
  type InsurancePolicyDoc,
  type InsuranceClaimDoc,
  type PolicyType,
  type PolicyRelationship,
  type PolicyStatus,
  type ClaimType,
  type ClaimStatus,
  type ClaimStatusChange,
} from "./insurance.model.js";

/* ── Policies ────────────────────────────────────────────────────────────────── */

export interface InsurancePolicy {
  id: string;
  patientId: string;
  insurer: string;
  tpaName?: string;
  policyNumber: string;
  policyType: PolicyType;
  planName?: string;
  policyHolderName?: string;
  relationship?: PolicyRelationship;
  validFrom?: string;
  validTo?: string;
  sumInsured?: number;
  status: PolicyStatus;
  notes?: string;
  branchId?: string;
}

function toPolicy(doc: InsurancePolicyDoc): InsurancePolicy {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId,
    insurer: doc.insurer,
    ...(doc.tpaName ? { tpaName: doc.tpaName } : {}),
    policyNumber: doc.policyNumber,
    policyType: doc.policyType,
    ...(doc.planName ? { planName: doc.planName } : {}),
    ...(doc.policyHolderName ? { policyHolderName: doc.policyHolderName } : {}),
    ...(doc.relationship ? { relationship: doc.relationship } : {}),
    ...(doc.validFrom ? { validFrom: doc.validFrom } : {}),
    ...(doc.validTo ? { validTo: doc.validTo } : {}),
    ...(doc.sumInsured != null ? { sumInsured: doc.sumInsured } : {}),
    status: doc.status,
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreatePolicyInput {
  patientId: string;
  insurer: string;
  tpaName?: string;
  policyNumber: string;
  policyType: PolicyType;
  planName?: string;
  policyHolderName?: string;
  relationship?: PolicyRelationship;
  validFrom?: string;
  validTo?: string;
  sumInsured?: number;
  notes?: string;
}

export async function createPolicy(input: CreatePolicyInput): Promise<InsurancePolicy> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getInsurancePolicyModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: input.patientId,
    insurer: input.insurer,
    ...(input.tpaName ? { tpaName: input.tpaName } : {}),
    policyNumber: input.policyNumber,
    policyType: input.policyType,
    ...(input.planName ? { planName: input.planName } : {}),
    ...(input.policyHolderName ? { policyHolderName: input.policyHolderName } : {}),
    ...(input.relationship ? { relationship: input.relationship } : {}),
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    ...(input.validTo ? { validTo: input.validTo } : {}),
    ...(input.sumInsured != null ? { sumInsured: input.sumInsured } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    status: "active",
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toPolicy(doc.toObject() as InsurancePolicyDoc);
}

export async function listPolicies(patientId: string): Promise<InsurancePolicy[]> {
  const docs = await getInsurancePolicyModel(getTenantDb())
    .find({ patientId, ...scopeFilter() })
    .sort({ createdAt: -1 })
    .lean<InsurancePolicyDoc[]>();
  return docs.map(toPolicy);
}

export async function findPolicyById(id: string): Promise<InsurancePolicy | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getInsurancePolicyModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<InsurancePolicyDoc>();
  return doc ? toPolicy(doc) : undefined;
}

export interface UpdatePolicyInput {
  insurer?: string;
  tpaName?: string;
  policyNumber?: string;
  policyType?: PolicyType;
  planName?: string;
  policyHolderName?: string;
  relationship?: PolicyRelationship;
  validFrom?: string;
  validTo?: string;
  sumInsured?: number;
  status?: PolicyStatus;
  notes?: string;
}

export async function updatePolicy(
  id: string,
  patch: UpdatePolicyInput,
): Promise<InsurancePolicy | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getInsurancePolicyModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<InsurancePolicyDoc>();
  return doc ? toPolicy(doc) : undefined;
}

/* ── Claims ──────────────────────────────────────────────────────────────────── */

export interface InsuranceClaim {
  id: string;
  patientId: string;
  policyId: string;
  encounterId?: string;
  invoiceId?: string;
  claimType: ClaimType;
  claimNumber?: string;
  claimedAmount: number;
  approvedAmount?: number;
  settledAmount?: number;
  status: ClaimStatus;
  notes?: string;
  statusHistory: ClaimStatusChange[];
  branchId?: string;
  createdAt: string;
}

function toClaim(doc: InsuranceClaimDoc): InsuranceClaim {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId,
    policyId: doc.policyId.toString(),
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    ...(doc.invoiceId ? { invoiceId: doc.invoiceId.toString() } : {}),
    claimType: doc.claimType,
    ...(doc.claimNumber ? { claimNumber: doc.claimNumber } : {}),
    claimedAmount: doc.claimedAmount,
    ...(doc.approvedAmount != null ? { approvedAmount: doc.approvedAmount } : {}),
    ...(doc.settledAmount != null ? { settledAmount: doc.settledAmount } : {}),
    status: doc.status,
    ...(doc.notes ? { notes: doc.notes } : {}),
    statusHistory: doc.statusHistory ?? [],
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

export interface CreateClaimInput {
  patientId: string;
  policyId: string;
  encounterId?: string;
  invoiceId?: string;
  claimType: ClaimType;
  claimNumber?: string;
  claimedAmount: number;
  notes?: string;
}

export async function createClaim(input: CreateClaimInput): Promise<InsuranceClaim> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getInsuranceClaimModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    patientId: input.patientId,
    policyId: new Types.ObjectId(input.policyId),
    ...(input.encounterId ? { encounterId: new Types.ObjectId(input.encounterId) } : {}),
    ...(input.invoiceId ? { invoiceId: new Types.ObjectId(input.invoiceId) } : {}),
    claimType: input.claimType,
    ...(input.claimNumber ? { claimNumber: input.claimNumber } : {}),
    claimedAmount: input.claimedAmount,
    ...(input.notes ? { notes: input.notes } : {}),
    status: "draft",
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
    ...(branchId ? { branchId } : {}),
  });
  return toClaim(doc.toObject() as InsuranceClaimDoc);
}

export async function listClaims(patientId: string): Promise<InsuranceClaim[]> {
  const docs = await getInsuranceClaimModel(getTenantDb())
    .find({ patientId, ...scopeFilter() })
    .sort({ createdAt: -1 })
    .lean<InsuranceClaimDoc[]>();
  return docs.map(toClaim);
}

export async function findClaimDocById(id: string): Promise<InsuranceClaimDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getInsuranceClaimModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<InsuranceClaimDoc>();
  return doc ?? undefined;
}

/**
 * Applies a claim transition: writes the status, records the payer's figure at the step that
 * carries it (`approvedAmount` on a decision, `settledAmount` on settlement), and appends the
 * history line. The one place claim status ever changes.
 */
export async function setClaimStatus(
  id: string,
  to: ClaimStatus,
  change: ClaimStatusChange,
  amounts: { approvedAmount?: number; settledAmount?: number },
): Promise<InsuranceClaim | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const set: Record<string, unknown> = { status: to };
  if (amounts.approvedAmount != null) set.approvedAmount = amounts.approvedAmount;
  if (amounts.settledAmount != null) set.settledAmount = amounts.settledAmount;

  const doc = await getInsuranceClaimModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: set, $push: { statusHistory: change } },
      { new: true },
    )
    .lean<InsuranceClaimDoc>();
  return doc ? toClaim(doc) : undefined;
}
