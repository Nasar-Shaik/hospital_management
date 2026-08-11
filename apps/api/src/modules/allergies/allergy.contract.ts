/**
 * Allergy response contracts.
 *
 * ── WHY THE RESPONSE IS `Allergy & { label }` ───────────────────────────────
 * The stored record holds the allergen CODE; the label is resolved from `ALLERGENS` on the way
 * out. A screen that shows a code nobody recognises is a safety feature nobody reads, so the
 * label travels with the record rather than being looked up again by every client.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { ALLERGY_SEVERITIES, ALLERGY_STATUSES } from "./allergy.model.js";
import type { Allergy } from "./allergy.repository.js";

export const allergy = contract(
  "Allergy",
  z.object({
    id: z.string(),
    patientId: z.string(),
    /** A code from `ALLERGENS` — never free text, or the interaction check never fires. */
    allergen: z.string(),
    severity: z.enum(ALLERGY_SEVERITIES),
    reaction: z.string().optional(),
    status: z.enum(ALLERGY_STATUSES),
    notedBy: z.string(),
    notedAt: z.string(),
    refutedBy: z.string().optional(),
    refutedAt: z.string().optional(),
    refutedReason: z.string().optional(),
    /** TENANT-WIDE safety exception (ADR-0015): an allergy follows the patient across sites. */
    branchId: z.string().optional(),
    /** The human-readable allergen name, resolved on the way out. */
    label: z.string(),
  }),
);
export type AllergyProof = Proves<Matches<typeof allergy, Allergy & { label: string }>>;
