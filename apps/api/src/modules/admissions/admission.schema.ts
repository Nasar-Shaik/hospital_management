/**
 * Admission DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { WARD_NOTE_TYPES } from "./wardNote.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const addNoteSchema = z
  .object({
    /** The ward round entry. Free text — a note is prose, and pretending otherwise
     * produces tick-boxes nobody reads and a narrative nobody wrote. */
    text: z.string().min(1).max(20_000),
  })
  .strict();

/**
 * A nursing entry (M3-S2). Deliberately the same shape as `addNoteSchema`, and deliberately a
 * SEPARATE constant: the two are free to diverge, and sharing one would mean a field added for
 * the doctor's note silently appearing on the nurse's.
 *
 * `.strict()` with no `type` field is what makes the route un-repurposable — a client cannot ask
 * this endpoint for a `discharge_summary`, because naming a type at all is a 400. The service
 * then sets the type itself. Structure, not a check that could be edited away.
 */
export const addNursingNoteSchema = z
  .object({
    /** What was observed, done, or handed over. Prose, like every other clinical note. */
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

/**
 * `WARD_NOTE_TYPES` rather than a hand-copied list: the two had already been written out twice,
 * and a filter that silently cannot name a type is how a whole class of note becomes invisible
 * to the one screen built to find it.
 */
export const listNotesQuerySchema = z.object({ type: z.enum(WARD_NOTE_TYPES).optional() }).strict();

/**
 * A bed-to-bed transfer (B4). Prefer a `bedId` from the catalogue; `ward`+`bedCode` is the legacy
 * free-text path for a hospital with no bed inventory. `.superRefine` requires one or the other.
 */
export const transferBedSchema = z
  .object({
    bedId: objectId.optional(),
    ward: z.string().trim().min(1).max(100).optional(),
    bedCode: z.string().trim().min(1).max(32).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.bedId && !(b.ward && b.bedCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pick a bed (bedId) or give the ward and bedCode",
        path: ["bedId"],
      });
    }
  });

/**
 * `?ward=` narrows to one ward by NAME, `page`/`limit` page it. Same shape and same defaults as
 * every other list here — a second pagination dialect would be a permanent tax on every client.
 */
export const worklistQuerySchema = z
  .object({
    ward: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type WorklistQuery = z.infer<typeof worklistQuerySchema>;
export type AddNoteBody = z.infer<typeof addNoteSchema>;
export type AddNursingNoteBody = z.infer<typeof addNursingNoteSchema>;
export type DischargeBody = z.infer<typeof dischargeSchema>;
export type OutcomeBody = z.infer<typeof outcomeSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
export type TransferBedBody = z.infer<typeof transferBedSchema>;
