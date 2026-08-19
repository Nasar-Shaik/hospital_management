/**
 * Emergency DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { TRIAGE_PRIORITIES } from "./emergency.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/**
 * Triage. `priority` is REQUIRED and has no default: a default would mean the product deciding how
 * sick somebody is when nobody said, and the whole value of this record is that a person did.
 */
export const triageSchema = z
  .object({
    encounterId: objectId,
    priority: z.enum(TRIAGE_PRIORITIES),
    chiefComplaint: z.string().trim().max(500).optional(),
  })
  .strict();

/** Sent to another facility. The destination is required — "transferred" alone is not a record. */
export const transferOutSchema = z
  .object({
    encounterId: objectId,
    destination: z.string().trim().min(2).max(200),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export type TriageBody = z.infer<typeof triageSchema>;
export type TransferOutBody = z.infer<typeof transferOutSchema>;
