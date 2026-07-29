/**
 * Asset + maintenance routes (Module B7).
 *
 * ── GATED ON `module.support.assets` ────────────────────────────────────────
 * Only a hospital that tracks its equipment formally buys this; the editions that carry the flag
 * switch it on. A tenant without it gets "not in your edition" (HMS-PLAN-002), which names the
 * truth, rather than a permission error no role edit could fix.
 *
 * ── ONE PERMISSION, DELIBERATELY ────────────────────────────────────────────
 * Everything here is `asset:manage` ("Manage assets and maintenance"). The register is a
 * biomedical-engineer / facilities function, not something every clinical user reads — there is no
 * read-only audience worth a second permission, so reads and writes share the one that already
 * exists. TENANT_ADMIN holds it.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./asset.controller.js";
import {
  createAssetSchema,
  updateAssetSchema,
  addMaintenanceSchema,
  listAssetsQuerySchema,
  idParamSchema,
} from "./asset.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.SUPPORT_ASSETS } as const;

export function assetRouter(): Router {
  const router = Router();

  router.get(
    "/assets",
    authenticate(),
    authorize(PERMISSIONS.ASSET_MANAGE, FEATURE),
    validate(listAssetsQuerySchema, "query"),
    asyncHandler(controller.listAssets),
  );

  router.post(
    "/assets",
    authenticate(),
    authorize(PERMISSIONS.ASSET_MANAGE, FEATURE),
    validate(createAssetSchema),
    asyncHandler(controller.createAsset),
  );

  router.patch(
    "/assets/:id",
    authenticate(),
    authorize(PERMISSIONS.ASSET_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateAssetSchema),
    asyncHandler(controller.updateAsset),
  );

  router.get(
    "/assets/:id/maintenance",
    authenticate(),
    authorize(PERMISSIONS.ASSET_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.listMaintenance),
  );

  router.post(
    "/assets/:id/maintenance",
    authenticate(),
    authorize(PERMISSIONS.ASSET_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(addMaintenanceSchema),
    asyncHandler(controller.addMaintenance),
  );

  return router;
}
