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
import { Router, json } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds, respondsFile } from "../../middleware/responds.js";
import * as controller from "./site.controller.js";
import { editableSite, logoDeletedAck, logoUploadedAck, publicSite } from "./site.contract.js";
import { updateSiteSchema, uploadLogoSchema } from "./site.schema.js";

export function siteRouter(): Router {
  const router = Router();

  // Public — no authenticate. Tenant is resolved from the host.
  router.get("/site", responds(publicSite), asyncHandler(controller.publicSite));
  // Public — the logo is shown on the logged-out login page and the public site.
  router.get(
    "/site/logo",
    respondsFile({
      media: ["*/*"],
      description:
        "The hospital logo, served with the content type it was uploaded with and cached for " +
        "five minutes. Public: no token, tenant resolved from the host.",
      also: [
        {
          status: 404,
          description:
            "No logo has been uploaded. The body is EMPTY — this one route answers a bare 404 " +
            "rather than the error envelope, so a client must not try to parse it. `hasLogo` on " +
            "`GET /site` is the cheap way to know in advance.",
        },
      ],
    }),
    asyncHandler(controller.publicLogo),
  );

  router.get(
    "/site/settings",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    responds(editableSite),
    asyncHandler(controller.getSettings),
  );

  router.patch(
    "/site/settings",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    validate(updateSiteSchema),
    responds(editableSite),
    asyncHandler(controller.updateSettings),
  );

  router.put(
    "/site/logo",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    // A base64 logo exceeds the app-wide 1 MB JSON limit only slightly; this route accepts more.
    json({ limit: "2mb" }),
    validate(uploadLogoSchema),
    responds(logoUploadedAck),
    asyncHandler(controller.uploadLogo),
  );

  router.delete(
    "/site/logo",
    authenticate(),
    authorize(PERMISSIONS.BRANDING_MANAGE),
    responds(logoDeletedAck),
    asyncHandler(controller.deleteLogo),
  );

  return router;
}
