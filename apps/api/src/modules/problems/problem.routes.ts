/**
 * Problem list routes.
 *
 * ── GATED ON `module.clinical.emr`, LIKE THE CONSULTATION NOTE ──────────────
 * A problem list is EMR depth and its only source is the structured note, so a hospital without
 * the note has nothing to promote from. A tenant without the flag gets "not in your edition"
 * rather than a permission error no role edit could fix. (Allergies carry NO flag, deliberately —
 * a clinic that prescribes must see them or it prescribes blind. That argument does not extend
 * here: a missing problem list does not wave a fatal drug through.)
 *
 * ── NO NEW PERMISSION FAMILY ────────────────────────────────────────────────
 * `emr:read` / `emr:write` — the same pair that already guards the consultation note, the ward
 * note and the visit summary. A problem is the same kind of clinical statement by the same
 * people, and a `problem:*` family would mean role-catalogue churn for a distinction nobody in a
 * hospital would recognise.
 *
 * The reach of these routes is decided in the REPOSITORY, not by the permission's declared scope
 * — `emr:read` is `branch`-scoped, and `problem.repository.ts` does not call `scopeFilter()`.
 * That file's header is the explanation; this note exists so a reader of the routes knows to go
 * and read it.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./problem.controller.js";
import { problem } from "./problem.contract.js";
import {
  addProblemSchema,
  idParamSchema,
  patientIdParamSchema,
  promoteProblemSchema,
  resolveProblemSchema,
} from "./problem.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_EMR_BASIC } as const;

export function problemRouter(): Router {
  const router = Router();

  router.get(
    "/patients/:patientId/problems",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(patientIdParamSchema, "params"),
    responds(problem.array()),
    asyncHandler(controller.list),
  );

  router.post(
    "/patients/:patientId/problems",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(patientIdParamSchema, "params"),
    validate(addProblemSchema),
    responds(problem, { status: 201 }),
    asyncHandler(controller.add),
  );

  /**
   * Promotion — from the CLINICIAN'S consultation, and from nowhere else. There is deliberately
   * no equivalent route under `/encounters/:id/coding`; see `problem.service.ts`.
   */
  router.post(
    "/encounters/:id/problems/promote",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(idParamSchema, "params"),
    validate(promoteProblemSchema),
    responds(problem, { status: 201 }),
    asyncHandler(controller.promote),
  );

  /** Closes a problem. It leaves the active list and stays on the record. */
  router.post(
    "/problems/:id/resolve",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(idParamSchema, "params"),
    validate(resolveProblemSchema),
    responds(problem),
    asyncHandler(controller.resolve),
  );

  return router;
}
