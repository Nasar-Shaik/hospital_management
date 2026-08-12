/**
 * Branch DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { isValidTimeZone } from "../../core/time/zone.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/**
 * An IANA zone this runtime can actually format in.
 *
 * Unvalidated, this field reached `Intl.DateTimeFormat` in `calendarDaysStarted` and threw a
 * `RangeError` — one typo in a branch record became a 500 on every bed-day calculation for that
 * site. The rule deliberately rejects `IST` and `+05:30`, which `Intl` accepts and silently
 * resolves to the wrong thing; see `core/time/zone.ts` for why neither obvious check works alone.
 */
const timezone = z.string().trim().max(64).refine(isValidTimeZone, {
  message: "expected an IANA zone such as Asia/Kolkata — not an abbreviation or a UTC offset",
});

export const createBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    /** Short, human key on reports. Uppercased in the service; unique per tenant. */
    code: z.string().trim().min(1).max(24),
    address: z.string().trim().max(500).optional(),
    contactPhone: z.string().trim().max(40).optional(),
    contactEmail: z.string().trim().email().max(160).optional(),
    timezone: timezone.optional(),
    gstin: z.string().trim().max(32).optional(),
  })
  .strict();

export const updateBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    address: z.string().trim().max(500).optional(),
    contactPhone: z.string().trim().max(40).optional(),
    contactEmail: z.string().trim().email().max(160).optional(),
    timezone: timezone.optional(),
    gstin: z.string().trim().max(32).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const branchIdParamSchema = z.object({ id: objectId }).strict();

export type CreateBranchBody = z.infer<typeof createBranchSchema>;
export type UpdateBranchBody = z.infer<typeof updateBranchSchema>;
