/**
 * Shared Zod schemas — the single source of DTO truth for FE + BE (Doc 09 §5).
 * Module schemas land here per phase; Sprint 0 ships only cross-cutting ones.
 */
import { z } from "zod";

export { z };

/** Standard list-query params (Doc 04 §5.1). `.strict()` per Doc 09 §6. */
export const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().optional(),
    q: z.string().optional(),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;

/** ObjectId shape used by route params until Mongoose lands in P1. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");
