/**
 * Auth routes (Doc 02 A3, Doc 04 §5.1).
 *
 * PUBLIC vs PROTECTED is explicit on every line below — there is no "protect
 * everything by default and remember to open holes", because that pattern fails
 * silently in the dangerous direction. A reader can see, in one screen, exactly
 * which endpoints an anonymous caller can reach.
 *
 * Even the public routes are tenant-scoped: this router mounts under
 * `/api/v1`, which is behind `resolveTenant`. You cannot log in without first
 * naming a hospital via the Host header.
 */
import { Router } from "express";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./auth.controller.js";
import {
  authenticatedUser,
  forgotPasswordAck,
  loggedOutAck,
  loginResult,
  mfaActivationResult,
  mfaDisabledAck,
  mfaSetupResult,
  passwordChangedAck,
  passwordResetAck,
  session,
  sessionRevokedAck,
  tokenPair,
} from "./auth.contract.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  mfaActivateSchema,
  mfaDisableSchema,
  mfaVerifySchema,
  refreshSchema,
  resetPasswordSchema,
  sessionIdParamSchema,
} from "./auth.schema.js";

export function authRouter(): Router {
  const router = Router();

  /* ── public ────────────────────────────────────────────────────────────── */

  router.post(
    "/login",

    validate(loginSchema),

    responds(loginResult),

    asyncHandler(controller.login),
  );

  // Refresh is public because an expired access token is exactly the situation
  // it exists to fix. Its authority is the refresh token itself.
  router.post(
    "/refresh",
    validate(refreshSchema.partial()),
    responds(tokenPair),
    asyncHandler(controller.refresh),
  );

  // Completes a login: the MFA challenge token IS the credential here.
  router.post(
    "/mfa/verify",
    validate(mfaVerifySchema),
    responds(tokenPair),
    asyncHandler(controller.verifyMfa),
  );

  // Forgot password: emails a single-use reset link. Public — the caller has, by definition, no
  // session. Answers the same way for any email, so it cannot be used to enumerate accounts.
  router.post(
    "/forgot-password",
    validate(forgotPasswordSchema),
    responds(forgotPasswordAck),
    asyncHandler(controller.forgotPassword),
  );

  // Reset password from the emailed link. Public — the token IS the credential, single-use and
  // short-lived; a successful reset revokes every existing session.
  router.post(
    "/reset-password",
    validate(resetPasswordSchema),
    responds(passwordResetAck),
    asyncHandler(controller.resetPassword),
  );

  /* ── authenticated ─────────────────────────────────────────────────────── */

  router.post(
    "/logout",

    authenticate(),

    validate(logoutSchema),

    responds(loggedOutAck),

    asyncHandler(controller.logout),
  );

  router.get(
    "/me",

    authenticate(),

    responds(authenticatedUser),

    asyncHandler(controller.me),
  );

  router.post(
    "/change-password",
    authenticate(),
    validate(changePasswordSchema),
    responds(passwordChangedAck),
    asyncHandler(controller.changePassword),
  );

  router.get(
    "/sessions",

    authenticate(),

    responds(session.array()),

    asyncHandler(controller.listSessions),
  );
  router.delete(
    "/sessions/:id",
    authenticate(),
    validate(sessionIdParamSchema, "params"),
    responds(sessionRevokedAck),
    asyncHandler(controller.revokeSession),
  );

  router.post(
    "/mfa/setup",

    authenticate(),

    responds(mfaSetupResult),

    asyncHandler(controller.setupMfa),
  );
  router.post(
    "/mfa/activate",
    authenticate(),
    validate(mfaActivateSchema),
    responds(mfaActivationResult),
    asyncHandler(controller.activateMfa),
  );
  router.post(
    "/mfa/disable",
    authenticate(),
    validate(mfaDisableSchema),
    responds(mfaDisabledAck),
    asyncHandler(controller.disableMfa),
  );

  return router;
}
