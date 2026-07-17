/**
 * Site routes.
 *
 * ── ONE PUBLIC ROUTE, TWO ADMIN ROUTES ──────────────────────────────────────
 * `GET /site` is served WITHOUT `authenticate()` — the same public pattern as `/login`
 * (auth.routes.ts). It still runs under `resolveTenant`, so it reads THIS hospital's content
 * and no other; the hostname is the tenant. It is the one endpoint a logged-out visitor hits,
 * so it returns only what is safe to show the world (see the service).
 *
 * The two `/site/settings` routes are the admin's editor, gated on `branding:manage` — a
 * tenant-scoped permission the platform defined for exactly this and that TENANT_ADMIN
 * inherits. Editing the shop window is an administrator's job, not a clinician's.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./site.controller.js";
import { updateSiteSchema } from "./site.schema.js";

export function siteRouter(): Router {
  const router = Router();

  // Public — no authenticate. Tenant is resolved from the host.
  router.get("/site", asyncHandler(controller.publicSite));

  router.get(
    "/site/settings",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    asyncHandler(controller.getSettings),
  );

  router.patch(
    "/site/settings",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    validate(updateSiteSchema),
    asyncHandler(controller.updateSettings),
  );

  return router;
}
