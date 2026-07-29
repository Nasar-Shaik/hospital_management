/**
 * Insurance service — policies and the claim lifecycle (Doc 02 finance).
 *
 * It enforces what the shape cannot: a claim is filed against a policy that actually belongs to the
 * same patient; a payer decision carries the figure it decided; a claim only moves along an edge the
 * machine allows; and SETTLEMENT is a separate act (its own permission) from deciding a claim — the
 * money landing is reconciliation, not adjudication.
 */
import { getContext } from "../../core/context/requestContext.js";
import { AppError } from "../../core/errors/appError.js";
import * as repo from "./insurance.repository.js";
import { canTransition, isApprovedState, type ClaimStatus } from "./insurance.model.js";

export type { InsurancePolicy, InsuranceClaim } from "./insurance.repository.js";

export const listPolicies = repo.listPolicies;
export const listClaims = repo.listClaims;
export const linkPolicy = repo.createPolicy;

export async function updatePolicy(
  id: string,
  patch: repo.UpdatePolicyInput,
): Promise<repo.InsurancePolicy> {
  const updated = await repo.updatePolicy(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Policy not found", { id });
  return updated;
}

export interface FileClaimInput {
  patientId: string;
  policyId: string;
  encounterId?: string;
  claimType: repo.CreateClaimInput["claimType"];
  claimNumber?: string;
  claimedAmount: number;
  notes?: string;
}

export async function fileClaim(input: FileClaimInput): Promise<repo.InsuranceClaim> {
  const policy = await repo.findPolicyById(input.policyId);
  // The policy must exist, be in the caller's scope, AND back THIS patient — a claim on someone
  // else's policy is either a mistake or a leak, and both are stopped here.
  if (!policy || policy.patientId !== input.patientId) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      policyId: ["choose one of this patient's policies"],
    });
  }
  return repo.createClaim(input);
}

/**
 * Moves a claim along its lifecycle — everything EXCEPT settlement, which is a separate,
 * separately-permissioned act. A decision (`approved` / `partially_approved`) must carry the
 * payer's approved figure; nothing else does.
 */
export async function transitionClaim(
  id: string,
  to: ClaimStatus,
  input: { approvedAmount?: number; note?: string },
): Promise<repo.InsuranceClaim> {
  const claim = await repo.findClaimDocById(id);
  if (!claim) throw new AppError("HMS-GEN-404", 404, "Claim not found", { id });

  if (to === "settled") {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      from: claim.status,
      to,
      reason: "settlement is recorded through the settle action (insurance:reconcile)",
    });
  }
  if (!canTransition(claim.status, to)) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      from: claim.status,
      to,
    });
  }
  if (isApprovedState(to) && input.approvedAmount == null) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      approvedAmount: ["record the amount the payer approved"],
    });
  }
  if (input.approvedAmount != null && input.approvedAmount > claim.claimedAmount) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      approvedAmount: ["cannot approve more than was claimed"],
    });
  }

  const ctx = getContext();
  const updated = await repo.setClaimStatus(
    id,
    to,
    {
      from: claim.status,
      to,
      at: new Date(),
      ...(ctx.userId ? { by: ctx.userId } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    isApprovedState(to) ? { approvedAmount: input.approvedAmount } : {},
  );
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Claim not found", { id });
  return updated;
}

/**
 * Records that the payer's money has landed — reconciliation, gated on `insurance:reconcile`. Only
 * a claim the payer has already decided (approved / partially_approved) can be settled.
 */
export async function settleClaim(
  id: string,
  input: { settledAmount: number; note?: string },
): Promise<repo.InsuranceClaim> {
  const claim = await repo.findClaimDocById(id);
  if (!claim) throw new AppError("HMS-GEN-404", 404, "Claim not found", { id });

  if (!canTransition(claim.status, "settled")) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      from: claim.status,
      to: "settled",
      reason: "only an approved claim can be settled",
    });
  }
  if (claim.approvedAmount != null && input.settledAmount > claim.approvedAmount) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      settledAmount: ["cannot settle more than was approved"],
    });
  }

  const ctx = getContext();
  const updated = await repo.setClaimStatus(
    id,
    "settled",
    {
      from: claim.status,
      to: "settled",
      at: new Date(),
      ...(ctx.userId ? { by: ctx.userId } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    { settledAmount: input.settledAmount },
  );
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Claim not found", { id });
  return updated;
}
