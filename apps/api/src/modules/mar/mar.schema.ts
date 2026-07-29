/**
 * MAR DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { MAR_STATUSES } from "./mar.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const recordAdministrationSchema = z
  .object({
    prescriptionId: objectId,
    /** Identifies the drug LINE on the prescription. */
    drugCode: z.string().trim().min(1).max(64),
    status: z.enum(MAR_STATUSES),
    /** When the dose was given; omit for now. */
    administeredAt: z.coerce.date().optional(),
    reason: z.string().trim().max(500).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const encounterIdParamSchema = z.object({ id: objectId }).strict();

export type RecordAdministrationBody = z.infer<typeof recordAdministrationSchema>;
