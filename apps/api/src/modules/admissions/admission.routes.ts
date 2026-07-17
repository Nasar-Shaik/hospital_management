/**
 * Admission routes.
 *
 * ── GATED ON `module.ops.ipd` ───────────────────────────────────────────────
 * A clinic and a diagnostic centre have no beds, and their editions do not carry this
 * flag. Everything here is meaningless without a ward, so the whole router sits behind it
 * — a clinic gets "not in your edition" (HMS-PLAN-002), which names the truth, rather than
 * "insufficient permission", which would send an admin hunting through the role editor for
 * a grant that can never help them.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `emr:write`  — write a ward note. Doctors and (later) nurses: the ward round is nursing
 *                work as much as medical, and NURSE already holds it.
 * `emr:read`   — read the chart. Everyone clinical, including the pharmacist.
 * `admission:discharge` — end the stay. A clinical decision, DOCTOR only. Deliberately
 *                not `emr:write`: writing the summary and deciding the patient is well
 *                enough to leave are different acts, and only one of them is a judgement.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./admission.controller.js";
import {
  addNoteSchema,
  dischargeSchema,
  outcomeSchema,
  idParamSchema,
  listNotesQuerySchema,
} from "./admission.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_IPD } as const;

export function admissionRouter(): Router {
  const router = Router();

  router.post(
    "/encounters/:id/notes",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(idParamSchema, "params"),
    validate(addNoteSchema),
    asyncHandler(controller.addNote),
  );

  router.get(
    "/encounters/:id/notes",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(idParamSchema, "params"),
    validate(listNotesQuerySchema, "query"),
    asyncHandler(controller.listNotes),
  );

  /** Writes the summary and ends the stay — the bed-days are billed from the event. */
  router.post(
    "/encounters/:id/discharge",
    authenticate(),
    authorize(PERMISSIONS.ADMISSION_DISCHARGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(dischargeSchema),
    asyncHandler(controller.discharge),
  );

  /**
   * Ends the stay WITHOUT a routine discharge — LAMA, absconded, or a death. Same authority
   * as discharge (`admission:discharge`): whoever may end a stay records how it ended. The
   * outcome note is written and the encounter closes carrying its true disposition.
   */
  router.post(
    "/encounters/:id/outcome",
    authenticate(),
    authorize(PERMISSIONS.ADMISSION_DISCHARGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(outcomeSchema),
    asyncHandler(controller.recordOutcome),
  );

  return router;
}
