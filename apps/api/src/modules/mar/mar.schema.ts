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
    /**
     * WHICH line, when `drugCode` alone is ambiguous — a prescription may carry the same drug
     * twice (a scheduled round and a PRN line). Optional: a code matching exactly one line still
     * resolves on its own, which is what keeps existing clients working. See `mar.service.ts`.
     */
    lineIndex: z.coerce.number().int().min(0).max(19).optional(),
    status: z.enum(MAR_STATUSES),
    /**
     * The dose slot being charted. Checked against the schedule derived from the prescription —
     * a client cannot declare "this was the 14:00 dose" when the order says otherwise. Omit it and
     * the server binds the nearest round itself; the uniqueness rule applies either way.
     */
    scheduledFor: z.coerce.date().optional(),
    /** When the dose was given; omit for now. */
    administeredAt: z.coerce.date().optional(),
    reason: z.string().trim().max(500).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const encounterIdParamSchema = z.object({ id: objectId }).strict();

/** `?date=YYYY-MM-DD` — the WARD's day, resolved in the branch zone, not the caller's. */
export const scheduleQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
  })
  .strict();

export type RecordAdministrationBody = z.infer<typeof recordAdministrationSchema>;
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;
