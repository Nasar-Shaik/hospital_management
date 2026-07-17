/**
 * Allergy DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { ALLERGENS } from "../drugSafety/index.js";
import { ALLERGY_SEVERITIES } from "./allergy.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/**
 * The allergen is one of the catalogue codes, enforced HERE at the edge — not free text.
 * A typed "penicilin" would be stored, shown, and never matched by the prescribing check,
 * which is the one failure mode this whole feature exists to prevent. `z.enum` over the
 * catalogue keys makes an unknown allergen a 400 with the valid options listed.
 */
const allergenCodes = Object.keys(ALLERGENS) as [string, ...string[]];

export const recordAllergySchema = z
  .object({
    allergen: z.enum(allergenCodes),
    severity: z.enum(ALLERGY_SEVERITIES).default("moderate"),
    reaction: z.string().max(2000).optional(),
  })
  .strict();

export const refuteAllergySchema = z
  .object({
    /** Why it is being ruled out. REQUIRED — a refuted allergy with no reason is indistinguishable
     * from an accident, and this is the record that stopped a safety alert from firing. */
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const patientIdParamSchema = z.object({ patientId: objectId }).strict();
export const idParamSchema = z.object({ id: objectId }).strict();

export type RecordAllergyBody = z.infer<typeof recordAllergySchema>;
export type RefuteAllergyBody = z.infer<typeof refuteAllergySchema>;
