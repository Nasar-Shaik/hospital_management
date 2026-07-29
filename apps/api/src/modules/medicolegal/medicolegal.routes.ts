/**
 * Medico-legal routes (Module C3) — informed consent and the death record.
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Every hospital, in every edition, takes consent and records deaths — these are statutory, not an
 * upsell. So the router carries no `feature` gate, the same call departments, branches and feedback
 * make: a permission a role either holds or does not, never "not in your edition".
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * READ (`emr:read`)          — see a patient's consents / death record. The clinical chart read the
 *                              doctor and nurse both hold.
 * CONSENT (`consent:manage`) — capture or withdraw a consent. The doctor explains it, the nurse
 *                              witnesses and records it — both hold it.
 * DEATH (`death:certify`)    — file the death record. A licensed act: the doctor alone certifies a
 *                              death, so it is guarded apart from ordinary record-writing.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./medicolegal.controller.js";
import {
  recordConsentSchema,
  withdrawConsentSchema,
  recordDeathSchema,
  patientQuerySchema,
  encounterQuerySchema,
  idParamSchema,
} from "./medicolegal.schema.js";

export function medicolegalRouter(): Router {
  const router = Router();

  /* ── consent ─────────────────────────────────────────────────────────── */

  router.get(
    "/consents",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(patientQuerySchema, "query"),
    asyncHandler(controller.listConsents),
  );

  router.post(
    "/consents",
    authenticate(),
    authorize(PERMISSIONS.CONSENT_MANAGE),
    validate(recordConsentSchema),
    asyncHandler(controller.recordConsent),
  );

  router.post(
    "/consents/:id/withdraw",
    authenticate(),
    authorize(PERMISSIONS.CONSENT_MANAGE),
    validate(idParamSchema, "params"),
    validate(withdrawConsentSchema),
    asyncHandler(controller.withdrawConsent),
  );

  /* ── death record ────────────────────────────────────────────────────── */

  router.get(
    "/death-records",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ),
    validate(encounterQuerySchema, "query"),
    asyncHandler(controller.getDeathRecord),
  );

  router.post(
    "/death-records",
    authenticate(),
    authorize(PERMISSIONS.DEATH_CERTIFY),
    validate(recordDeathSchema),
    asyncHandler(controller.recordDeath),
  );

  return router;
}
