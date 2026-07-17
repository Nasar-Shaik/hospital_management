/**
 * Reporting DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 *
 * Every report takes the SAME shape: a half-open period `[from, to)` and an optional format. The
 * web sends `to` as the start of the day AFTER the chosen end date, so a whole final day is
 * included without the 23:59:59.999 boundary trap. Dates are coerced here at the edge; no service
 * downstream parses a string.
 */
import { z } from "@medicore/validation";

export const reportRangeSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict()
  .refine((r) => r.from < r.to, { message: "`from` must be before `to`" });

export type ReportRangeQuery = z.infer<typeof reportRangeSchema>;
