/**
 * Mortuary register response contract.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { MORTUARY_STATUSES } from "./mortuary.model.js";
import type { MortuaryEntry } from "./mortuary.repository.js";

export const mortuaryEntry = contract(
  "MortuaryEntry",
  z.object({
    id: z.string(),
    patientId: z.string(),
    encounterId: z.string(),
    deathRecordId: z.string().optional(),
    deceasedName: z.string(),
    receivedAt: z.string(),
    receivedBy: z.string().optional(),
    /** The tag on the body — the register's human key. */
    tagNumber: z.string(),
    storageUnit: z.string().optional(),
    medicoLegal: z.boolean(),
    status: z.enum(MORTUARY_STATUSES),
    releasedAt: z.string().optional(),
    releasedBy: z.string().optional(),
    releasedTo: z.string().optional(),
    releasedRelationship: z.string().optional(),
    /** The police clearance reference, where the case needed one. */
    clearanceRef: z.string().optional(),
    remarks: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type MortuaryEntryProof = Proves<Matches<typeof mortuaryEntry, MortuaryEntry>>;
