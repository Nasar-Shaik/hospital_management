/**
 * Auth DTOs (Doc 09 §5/§6: Zod is the single source of DTO truth; `.strict()`
 * so an unexpected field is a 400, not a silently ignored one).
 *
 * These schemas will move to `packages/validation` when the Next.js apps start
 * consuming them, so the browser and the API validate identically from ONE
 * definition. Keeping them here until then avoids publishing a contract that no
 * client uses yet.
 */
import { z } from "@medicore/validation";
import { env } from "../../config/env.js";

export const loginSchema = z
  .object({
    email: z.string().email().max(254),
    // No max-length trap and no policy check on login: policy applies when a
    // password is SET. Validating it here would reject legitimate legacy
    // passwords and leak the policy to unauthenticated callers.
    password: z.string().min(1).max(512),
    /** Optional human-readable device label for the sessions screen. */
    device: z.string().max(120).optional(),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(20).max(512),
  })
  .strict();

export const logoutSchema = z
  .object({
    refreshToken: z.string().min(20).max(512).optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    /**
     * The bound comes from the POLICY, not from a literal.
     *
     * This was `min(8)` — a second, silent definition of "how long is a password"
     * that disagreed with `checkPasswordPolicy` the moment the configured minimum
     * moved. The schema would reject at 8 while the policy demanded 12, or reject
     * at 8 while the policy allowed 6, and the caller would get a validation error
     * that contradicted the rule the service was actually enforcing.
     *
     * One policy, one source. The service still re-checks (schemas bound length;
     * only the policy knows about history and complexity), but they can no longer
     * disagree about the number.
     */
    newPassword: z.string().min(env.PASSWORD_MIN_LENGTH).max(512),
  })
  .strict();

export const mfaVerifySchema = z
  .object({
    mfaToken: z.string().min(10),
    /** 6-digit TOTP, or a recovery code like `A1B2C-3D4E5`. */
    code: z.string().min(6).max(16),
  })
  .strict();

export const mfaActivateSchema = z
  .object({
    code: z
      .string()
      .length(6)
      .regex(/^\d{6}$/, "must be 6 digits"),
  })
  .strict();

export const mfaDisableSchema = z
  .object({
    password: z.string().min(1).max(512),
  })
  .strict();

export const sessionIdParamSchema = z
  .object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "invalid session id"),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
