/**
 * Insurance DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import {
  POLICY_TYPES,
  POLICY_RELATIONSHIPS,
  POLICY_STATUSES,
  CLAIM_TYPES,
  CLAIM_STATUSES,
} from "./insurance.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
/** A money amount in PAISE — a non-negative integer. */
const paise = z.number().int().min(0).max(100_000_000_000);

export const createPolicySchema = z
  .object({
    insurer: z.string().trim().min(1).max(120),
    tpaName: z.string().trim().max(120).optional(),
    policyNumber: z.string().trim().min(1).max(64),
    policyType: z.enum(POLICY_TYPES),
    planName: z.string().trim().max(120).optional(),
    policyHolderName: z.string().trim().max(120).optional(),
    relationship: z.enum(POLICY_RELATIONSHIPS).optional(),
    validFrom: isoDate.optional(),
    validTo: isoDate.optional(),
    sumInsured: paise.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export const updatePolicySchema = z
  .object({
    insurer: z.string().trim().min(1).max(120).optional(),
    tpaName: z.string().trim().max(120).optional(),
    policyNumber: z.string().trim().min(1).max(64).optional(),
    policyType: z.enum(POLICY_TYPES).optional(),
    planName: z.string().trim().max(120).optional(),
    policyHolderName: z.string().trim().max(120).optional(),
    relationship: z.enum(POLICY_RELATIONSHIPS).optional(),
    validFrom: isoDate.optional(),
    validTo: isoDate.optional(),
    sumInsured: paise.optional(),
    status: z.enum(POLICY_STATUSES).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const createClaimSchema = z
  .object({
    policyId: objectId,
    encounterId: objectId.optional(),
    invoiceId: objectId.optional(),
    claimType: z.enum(CLAIM_TYPES),
    claimNumber: z.string().trim().max(64).optional(),
    claimedAmount: paise,
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

/** Everything except settlement — `settled` is refused here (use the settle action). */
export const transitionClaimSchema = z
  .object({
    to: z.enum(CLAIM_STATUSES),
    approvedAmount: paise.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const settleClaimSchema = z
  .object({
    settledAmount: paise,
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const patientIdParamSchema = z.object({ patientId: objectId }).strict();
export const idParamSchema = z.object({ id: objectId }).strict();

export type CreatePolicyBody = z.infer<typeof createPolicySchema>;
export type UpdatePolicyBody = z.infer<typeof updatePolicySchema>;
export type CreateClaimBody = z.infer<typeof createClaimSchema>;
export type TransitionClaimBody = z.infer<typeof transitionClaimSchema>;
export type SettleClaimBody = z.infer<typeof settleClaimSchema>;
