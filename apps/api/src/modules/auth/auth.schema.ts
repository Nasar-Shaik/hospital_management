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
    /**
     * A human-readable device label for the sessions screen. Cosmetic, and treated
     * as such.
     *
     * ── IT IS TRUNCATED, NEVER REJECTED ─────────────────────────────────────
     * This was `.max(120)`, three lines under a comment warning against exactly this
     * ("no max-length trap on login"). Browsers send `navigator.userAgent`, which is
     * ~117 characters in desktop Chrome — UNDER the cap by a hair, and over it for
     * headless Chrome, many mobile browsers, and anything with an extra token in the
     * string. So a correct email and a correct password produced
     * `HMS-VAL-001: device — String must contain at most 120 character(s)`, and the
     * user is told their login failed with no idea why.
     *
     * Nobody may be locked out of their hospital because their browser is chatty. The
     * outer bound stays (an unbounded string is a payload someone will abuse) but it
     * is generous, and what exceeds the label length is cut rather than refused.
     */
    device: z
      .string()
      .max(1024)
      .transform((s) => s.slice(0, 120))
      .optional(),
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

export const forgotPasswordSchema = z
  .object({
    email: z.string().email().max(254),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    /** The opaque token from the emailed link. */
    token: z.string().min(20).max(512),
    // Bound from the POLICY, not a literal — same reason as changePassword above.
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
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
