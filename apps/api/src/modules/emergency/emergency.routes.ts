/**
 * Emergency department routes (D10).
 *
 * ── GATED ON `module.clinical.emergency`, WHICH UNTIL NOW GATED NOTHING ─────
 * The flag has been in the catalogue and in every hospital edition since the plans were written,
 * and no route in the product referenced it. A hospital was being sold an emergency department and
 * the only thing the flag did was appear on an invoice. This is the third time this repository has
 * found a capability sold and ungated (see PERMISSION_LIFECYCLE.md), and it is fixed the same way:
 * the routes that ARE the department now ask for it.
 *
 * ── WHAT THE FLAG DOES AND DOES NOT TURN OFF ────────────────────────────────
 * OFF: triage, the board, transfer-out — the emergency department as a workflow.
 * ON regardless: registering a visit with `origin: "emergency"` / `class: "ER"`. Those are
 * DESCRIPTIONS of how a patient arrived, they predate this module, and a clinic that records "came
 * in as an emergency" on a walk-in is telling the truth about its afternoon. Taking that away to
 * make a licensing boundary tidy would break existing data for no revenue.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * BOARD (`encounter:read`)   — the same permission as the queue board, because the ED board IS the
 *                              queue, filtered and ranked. Everyone who reads it — the ED nurse,
 *                              the doctor, the desk answering "where is my father" — already holds
 *                              it for the same patients. A dedicated "ED board read" would have to
 *                              be granted to exactly that set and would buy nothing.
 * TRIAGE (`triage:perform`)  — its own permission, because deciding how sick somebody is is a
 *                              clinical judgement and not queue management. The nurse and the
 *                              doctor hold it; the registration desk does NOT.
 * TRANSFER (`encounter:close`) — sending a patient to another hospital ENDS the visit here, and
 *                              ending a visit is already what this permission means. Reusing it
 *                              keeps one answer to "who may declare a patient finished".
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./emergency.controller.js";
import { edBoardRow, triage } from "./emergency.contract.js";
import { triageSchema, transferOutSchema } from "./emergency.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.CLINICAL_EMERGENCY } as const;

export function emergencyRouter(): Router {
  const router = Router();

  router.get(
    "/emergency/board",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    responds(edBoardRow.array()),
    asyncHandler(controller.board),
  );

  /**
   * Assess, or re-assess. An upsert on the encounter, so a deteriorating patient can be moved up
   * the board and a double-submit cannot leave two contradictory priorities on one patient.
   */
  router.post(
    "/emergency/triage",
    authenticate(),
    authorize(PERMISSIONS.TRIAGE_PERFORM, FEATURE),
    validate(triageSchema),
    responds(triage, { status: 201 }),
    asyncHandler(controller.triage),
  );

  router.post(
    "/emergency/transfer-out",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_CLOSE, FEATURE),
    validate(transferOutSchema),
    responds(triage, { status: 201 }),
    asyncHandler(controller.transferOut),
  );

  return router;
}
