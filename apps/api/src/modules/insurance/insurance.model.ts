/**
 * Patient insurance — policies + claims (Doc 02 finance, ADR-0013 §3 payer split).
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * Who PAYS for a patient's care when it is not the patient. Two things: the POLICY a patient holds
 * (insurer, number, cover, validity) and the CLAIMS filed against it (an amount asked of the payer
 * for a course of care, and how far it got — submitted, approved, settled or refused). One patient
 * may hold several policies; one policy backs many claims.
 *
 * ── THE CLAIM IS A STATE MACHINE, AND THE MONEY FOLLOWS IT ───────────────────
 * A claim moves draft → submitted → approved / partially_approved / rejected → settled. The amounts
 * arrive in step: `claimedAmount` at filing, `approvedAmount` when the payer decides, `settledAmount`
 * when the money actually lands. Each is stored (not derived) because the payer's approved figure is
 * a fact they hand you, not a percentage you compute — and it is frequently less than claimed. Every
 * move is appended to `statusHistory` with who and why. `transition()` is the only door, as the
 * appointment / ambulance / feedback machines do it.
 *
 * All money is PAISE — integer minor units — like every amount in the system.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** How the policy pays. `cashless` settles with the hospital directly; `reimbursement` pays the patient back. */
export const POLICY_TYPES = ["cashless", "reimbursement", "government", "corporate"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** Whose policy it is, relative to the patient — a family floater covers more than the holder. */
export const POLICY_RELATIONSHIPS = ["self", "spouse", "child", "parent", "other"] as const;
export type PolicyRelationship = (typeof POLICY_RELATIONSHIPS)[number];

/** `active` backs new claims; `inactive` is lapsed/withdrawn but its claims stay readable. */
export const POLICY_STATUSES = ["active", "inactive"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export interface InsurancePolicyDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: string;
  insurer: string;
  /** The third-party administrator, when the insurer settles through one. */
  tpaName?: string;
  policyNumber: string;
  policyType: PolicyType;
  planName?: string;
  policyHolderName?: string;
  relationship?: PolicyRelationship;

  /** `YYYY-MM-DD`, local reckoning — whole-day validity, no timezone (mirrors doctor leave). */
  validFrom?: string;
  validTo?: string;
  /** The cover ceiling in PAISE. */
  sumInsured?: number;

  status: PolicyStatus;
  notes?: string;

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CLAIM_TYPES = ["cashless", "reimbursement", "preauth"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "partially_approved",
  "rejected",
  "settled",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted", "rejected"],
  submitted: ["approved", "partially_approved", "rejected"],
  approved: ["settled"],
  partially_approved: ["settled"],
  rejected: [],
  settled: [],
};

export function canTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The statuses at which a payer has committed an approved figure. */
export function isApprovedState(s: ClaimStatus): boolean {
  return s === "approved" || s === "partially_approved";
}

export interface ClaimStatusChange {
  from: ClaimStatus;
  to: ClaimStatus;
  at: Date;
  by?: string;
  note?: string;
}

export interface InsuranceClaimDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: string;
  policyId: Types.ObjectId;
  /** The clinical visit this claim is for, when linked (ADR-0013). */
  encounterId?: Types.ObjectId;
  /** The bill this claim is against — the invoice whose insurer share it recovers (payer split). */
  invoiceId?: Types.ObjectId;

  claimType: ClaimType;
  /** The payer's own reference for this claim, once they issue one. */
  claimNumber?: string;

  claimedAmount: number;
  approvedAmount?: number;
  settledAmount?: number;

  status: ClaimStatus;
  notes?: string;
  statusHistory: ClaimStatusChange[];

  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const insurancePolicySchema = new Schema<InsurancePolicyDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: String, required: true },
    insurer: { type: String, required: true, trim: true, maxlength: 120 },
    tpaName: { type: String, trim: true, maxlength: 120 },
    policyNumber: { type: String, required: true, trim: true, maxlength: 64 },
    policyType: { type: String, enum: POLICY_TYPES, required: true, default: "cashless" },
    planName: { type: String, trim: true, maxlength: 120 },
    policyHolderName: { type: String, trim: true, maxlength: 120 },
    relationship: { type: String, enum: POLICY_RELATIONSHIPS },

    validFrom: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    validTo: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    sumInsured: { type: Number, min: 0 },

    status: { type: String, enum: POLICY_STATUSES, required: true, default: "active" },
    notes: { type: String, trim: true, maxlength: 1000 },

    createdBy: { type: String },
  },
  // Indexes owned by migration 0038, never autoIndex — see the patient model.
  { timestamps: true, collection: "insurancePolicies", autoIndex: false },
);

const insuranceClaimSchema = new Schema<InsuranceClaimDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: String, required: true },
    policyId: { type: Schema.Types.ObjectId, required: true },
    encounterId: { type: Schema.Types.ObjectId },
    invoiceId: { type: Schema.Types.ObjectId },

    claimType: { type: String, enum: CLAIM_TYPES, required: true, default: "cashless" },
    claimNumber: { type: String, trim: true, maxlength: 64 },

    claimedAmount: { type: Number, required: true, min: 0 },
    approvedAmount: { type: Number, min: 0 },
    settledAmount: { type: Number, min: 0 },

    status: { type: String, enum: CLAIM_STATUSES, required: true, default: "draft" },
    notes: { type: String, trim: true, maxlength: 1000 },
    statusHistory: {
      type: [
        new Schema<ClaimStatusChange>(
          {
            from: { type: String, required: true },
            to: { type: String, required: true },
            at: { type: Date, required: true },
            by: { type: String },
            note: { type: String },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },

    createdBy: { type: String },
  },
  { timestamps: true, collection: "insuranceClaims", autoIndex: false },
);

insurancePolicySchema.plugin(tenantScopePlugin);
insuranceClaimSchema.plugin(tenantScopePlugin);

// A policy + claim name a patient and their payer — PHI, like an allergy or a bill.
insurancePolicySchema.plugin(auditPlugin, { resource: "insurancePolicy", category: "phi" });
insuranceClaimSchema.plugin(auditPlugin, {
  resource: "insuranceClaim",
  category: "phi",
  ignore: ["statusHistory"],
});

export function getInsurancePolicyModel(conn: Connection): Model<InsurancePolicyDoc> {
  return (
    (conn.models.InsurancePolicy as Model<InsurancePolicyDoc>) ??
    conn.model<InsurancePolicyDoc>("InsurancePolicy", insurancePolicySchema)
  );
}

export function getInsuranceClaimModel(conn: Connection): Model<InsuranceClaimDoc> {
  return (
    (conn.models.InsuranceClaim as Model<InsuranceClaimDoc>) ??
    conn.model<InsuranceClaimDoc>("InsuranceClaim", insuranceClaimSchema)
  );
}
