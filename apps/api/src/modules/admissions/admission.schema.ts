/**
 * Admission DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const addNoteSchema = z
  .object({
    /** The ward round entry. Free text — a note is prose, and pretending otherwise
     * produces tick-boxes nobody reads and a narrative nobody wrote. */
    text: z.string().min(1).max(20_000),
  })
  .strict();

export const dischargeSchema = z
  .object({
    /** What happened during the stay. REQUIRED — a discharge with no summary is the
     * complaint every next doctor has about hospital software. */
    text: z.string().min(1).max(20_000),
    diagnosis: z.string().max(1000).optional(),
    advice: z.string().max(5000).optional(),
    /** `YYYY-MM-DD`. Coerced to a Date at the edge, never parsed in the service. */
    followUpOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
  })
  .strict();

/**
 * A non-routine ending: LAMA, absconded, or a death. `discharged` is deliberately NOT an
 * option here — a routine discharge goes through `POST .../discharge` with its summary.
 */
export const outcomeSchema = z
  .object({
    outcome: z.enum(["lama", "absconded", "deceased"]),
    /** The account of what happened. REQUIRED — this note IS the record of the ending. */
    text: z.string().min(1).max(20_000),
  })
  .strict();

export const listNotesQuerySchema = z
  .object({ type: z.enum(["progress", "discharge_summary", "outcome_note"]).optional() })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type AddNoteBody = z.infer<typeof addNoteSchema>;
export type DischargeBody = z.infer<typeof dischargeSchema>;
export type OutcomeBody = z.infer<typeof outcomeSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
