/**
 * Subscription DTOs (Doc 09 §5/§6).
 */
import { z } from "@medicore/validation";

export const changePlanSchema = z
  .object({
    planCode: z.string().regex(/^PLAN_[A-Z_]+$/, "must be a plan code such as PLAN_HOSPITAL"),
  })
  .strict();

export const featureOverrideSchema = z
  .object({
    flag: z.string().min(3).max(80),
    enabled: z.boolean(),
    /** An override with no reason becomes folklore nobody dares remove. */
    reason: z.string().min(3).max(200),
    /** ISO date. A trial add-on that never expires is just a free upgrade. */
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
