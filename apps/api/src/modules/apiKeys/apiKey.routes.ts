/**
 * API-key routes (Module A9).
 *
 * ── `apikey:manage` throughout ──────────────────────────────────────────────
 * Issuing a key mints a credential that acts with the creator's authority, and revoking one cuts
 * off an integration — both are administrative acts a hospital's admin owns (TENANT_ADMIN holds
 * `apikey:manage`), not something a clinician or the desk does. No feature flag: every edition can
 * have integrations.
 *
 * These routes MANAGE keys; they are reached with an ordinary session, not with a key. A key's own
 * power is exercised against the rest of the v1 API, resolved by the authenticate middleware.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./apiKey.controller.js";
import { createApiKeySchema, idParamSchema } from "./apiKey.schema.js";

export function apiKeyRouter(): Router {
  const router = Router();

  router.get(
    "/api-keys",
    authenticate(),
    authorize(PERMISSIONS.APIKEY_MANAGE),
    asyncHandler(controller.list),
  );

  router.post(
    "/api-keys",
    authenticate(),
    authorize(PERMISSIONS.APIKEY_MANAGE),
    validate(createApiKeySchema),
    asyncHandler(controller.create),
  );

  router.delete(
    "/api-keys/:id",
    authenticate(),
    authorize(PERMISSIONS.APIKEY_MANAGE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.revoke),
  );

  return router;
}
