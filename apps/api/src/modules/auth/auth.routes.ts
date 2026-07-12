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
import * as controller from "./auth.controller.js";
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  mfaActivateSchema,
  mfaDisableSchema,
  mfaVerifySchema,
  refreshSchema,
  sessionIdParamSchema,
} from "./auth.schema.js";

export function authRouter(): Router {
  const router = Router();

  /* ── public ────────────────────────────────────────────────────────────── */

  router.post("/login", validate(loginSchema), asyncHandler(controller.login));

  // Refresh is public because an expired access token is exactly the situation
  // it exists to fix. Its authority is the refresh token itself.
  router.post("/refresh", validate(refreshSchema.partial()), asyncHandler(controller.refresh));

  // Completes a login: the MFA challenge token IS the credential here.
  router.post("/mfa/verify", validate(mfaVerifySchema), asyncHandler(controller.verifyMfa));

  /* ── authenticated ─────────────────────────────────────────────────────── */

  router.post("/logout", authenticate(), validate(logoutSchema), asyncHandler(controller.logout));

  router.get("/me", authenticate(), asyncHandler(controller.me));

  router.post(
    "/change-password",
    authenticate(),
    validate(changePasswordSchema),
    asyncHandler(controller.changePassword),
  );

  router.get("/sessions", authenticate(), asyncHandler(controller.listSessions));
  router.delete(
    "/sessions/:id",
    authenticate(),
    validate(sessionIdParamSchema, "params"),
    asyncHandler(controller.revokeSession),
  );

  router.post("/mfa/setup", authenticate(), asyncHandler(controller.setupMfa));
  router.post(
    "/mfa/activate",
    authenticate(),
    validate(mfaActivateSchema),
    asyncHandler(controller.activateMfa),
  );
  router.post(
    "/mfa/disable",
    authenticate(),
    validate(mfaDisableSchema),
    asyncHandler(controller.disableMfa),
  );

  return router;
}
