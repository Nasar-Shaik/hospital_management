/**
 * Patient response contracts.
 *
 * `branchId` is optional and that is deliberate (ADR-0015): a patient is HYBRID — the identity is
 * tenant-wide, the registration happened at a site. Documenting it as optional is the honest
 * description of rows that predate branches, and it is exactly the field a client must not lose.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import { BLOOD_GROUPS, GENDERS, PATIENT_STATUSES } from "./patient.model.js";
import type { Patient } from "./patient.repository.js";
import type { DuplicateCandidate } from "./mpi.js";
import type { mergePatients, RegisterPatientResult } from "./patient.service.js";

export const patient = contract(
  "Patient",
  z.object({
    id: z.string(),
    /** The number on the wristband. Tenant-scoped, permanent, never reused. */
    uhid: z.string(),
    name: z.string(),
    gender: z.enum(GENDERS),
    status: z.enum(PATIENT_STATUSES),
    dob: z.string().optional(),
    bloodGroup: z.enum(BLOOD_GROUPS).optional(),
    branchId: z.string().optional(),
    contact: z.object({ phone: z.string().optional(), email: z.string().optional() }),
    address: z
      .object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string().optional(),
      })
      .optional(),
    /** Set when this record was merged INTO another — it is no longer the live chart. */
    mergedInto: z.string().optional(),
    mergedAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type PatientProof = Proves<Matches<typeof patient, Patient>>;

/** A near-miss from the master patient index, with the reason it matched. */
export const duplicateCandidate = contract(
  "DuplicateCandidate",
  z.object({ patient, score: z.number(), matchedOn: z.array(z.string()) }),
);
export type DuplicateCandidateProof = Proves<
  Matches<typeof duplicateCandidate, DuplicateCandidate>
>;

export const registerPatientResult = contract(
  "RegisterPatientResult",
  z.object({ patient, possibleDuplicates: z.array(duplicateCandidate) }),
);
export type RegisterPatientResultProof = Proves<
  Matches<typeof registerPatientResult, RegisterPatientResult>
>;

/** The two charts after a merge: the one that survived, and the one that now points at it. */
export const mergeResult = contract(
  "MergeResult",
  z.object({ survivor: patient, merged: patient }),
);
export type MergeResultProof = Proves<Matches<typeof mergeResult, Returns<typeof mergePatients>>>;
