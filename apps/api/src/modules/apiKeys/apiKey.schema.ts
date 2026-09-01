/**
 * API-key DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** `YYYY-MM-DD` hard expiry, optional. Coerced to a Date at the edge, never in the service. */
    expiresOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>;
