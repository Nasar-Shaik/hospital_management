/**
 * Hospital profile response contract — the registered identity of the organisation.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { OWNERSHIP_TYPES } from "./hospitalProfile.model.js";
import type { HospitalProfile } from "./hospitalProfile.repository.js";

export const hospitalProfile = contract(
  "HospitalProfile",
  z.object({
    legalName: z.string().optional(),
    registrationNumber: z.string().optional(),
    taxId: z.string().optional(),
    accreditations: z.array(z.string()).optional(),
    establishedYear: z.number().optional(),
    ownershipType: z.enum(OWNERSHIP_TYPES).optional(),
    licensedBeds: z.number().optional(),
    address: z.string().optional(),
    officialEmail: z.string().optional(),
    officialPhone: z.string().optional(),
    website: z.string().optional(),
    headName: z.string().optional(),
    headTitle: z.string().optional(),
  }),
);
export type HospitalProfileProof = Proves<Matches<typeof hospitalProfile, HospitalProfile>>;
