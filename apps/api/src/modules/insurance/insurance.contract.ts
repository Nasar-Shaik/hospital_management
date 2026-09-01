/**
 * Insurance response contracts — policies and the claims made against them.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import {
  CLAIM_STATUSES,
  CLAIM_TYPES,
  POLICY_RELATIONSHIPS,
  POLICY_STATUSES,
  POLICY_TYPES,
} from "./insurance.model.js";
import type { InsuranceClaim, InsurancePolicy } from "./insurance.repository.js";

const claimStatus = z.enum(CLAIM_STATUSES);
const paise = z.number().int();

export const insurancePolicy = contract(
  "InsurancePolicy",
  z.object({
    id: z.string(),
    patientId: z.string(),
    insurer: z.string(),
    /** The third-party administrator, where one stands between hospital and insurer. */
    tpaName: z.string().optional(),
    policyNumber: z.string(),
    policyType: z.enum(POLICY_TYPES),
    planName: z.string().optional(),
    policyHolderName: z.string().optional(),
    /** The patient's relationship to the holder — a child is covered on a parent's policy. */
    relationship: z.enum(POLICY_RELATIONSHIPS).optional(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    /** Paise. */
    sumInsured: paise.optional(),
    status: z.enum(POLICY_STATUSES),
    notes: z.string().optional(),
    branchId: z.string().optional(),
  }),
);
export type InsurancePolicyProof = Proves<Matches<typeof insurancePolicy, InsurancePolicy>>;

export const claimStatusChange = contract(
  "ClaimStatusChange",
  z.object({
    from: claimStatus,
    to: claimStatus,
    at: z.string(),
    by: z.string().optional(),
    note: z.string().optional(),
  }),
);

export const insuranceClaim = contract(
  "InsuranceClaim",
  z.object({
    id: z.string(),
    patientId: z.string(),
    policyId: z.string(),
    encounterId: z.string().optional(),
    invoiceId: z.string().optional(),
    claimType: z.enum(CLAIM_TYPES),
    claimNumber: z.string().optional(),
    /** Paise, all three. Approved and settled arrive as the insurer decides them. */
    claimedAmount: paise,
    approvedAmount: paise.optional(),
    settledAmount: paise.optional(),
    status: claimStatus,
    notes: z.string().optional(),
    statusHistory: z.array(claimStatusChange),
    branchId: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type InsuranceClaimProof = Proves<Matches<typeof insuranceClaim, InsuranceClaim>>;
