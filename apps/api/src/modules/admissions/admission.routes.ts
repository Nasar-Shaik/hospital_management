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
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./admission.controller.js";
import {
  bedBoard,
  dischargeResult,
  outcomeResult,
  transferBedResult,
  wardNote,
} from "./admission.contract.js";
import {
  addNoteSchema,
  dischargeSchema,
  outcomeSchema,
  idParamSchema,
  listNotesQuerySchema,
  transferBedSchema,
} from "./admission.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_IPD } as const;

export function admissionRouter(): Router {
  const router = Router();

  /**
   * The bed board — the inventory (B4) joined to who is currently admitted. `emr:read`, like the
   * catalogue reads it draws on: the doctor about to admit and the nurse working the ward both
   * need to see which beds are free.
   */
  router.get(
    "/bed-board",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    responds(bedBoard),
    asyncHandler(controller.getBedBoard),
  );

  /**
   * ── A WARD NOTE IS APPEND-ONLY, SO A RETRY IS PERMANENT ─────────────────────
   * There is no update path and no delete path (`wardNote.model.ts` explains why), and the
   * repository does not de-duplicate. Before this key, a client whose response was lost on ward
   * wifi and pressed save again left TWO identical contemporaneous entries on a medico-legal
   * record, for ever. Nothing server-side stopped it.
   *
   * `idempotent()` is the mechanism the rest of the API already uses for exactly this — the
   * sibling `POST /encounters/:id/admit` carries it — so the retry now replays the original 201
   * and writes nothing. Honoured, not demanded: a request with no header behaves precisely as it
   * did, which is what keeps this additive inside v1 (Doc 04 §5.1).
   *
   * It sits last, after `validate`, so the fingerprint is taken from the PARSED body and a
   * malformed first attempt does not burn the key.
   */
  router.post(
    "/encounters/:id/notes",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(idParamSchema, "params"),
    validate(addNoteSchema),
    responds(wardNote, { status: 201 }),
    idempotent("Replays the ward note this key already wrote."),
    asyncHandler(controller.addNote),
  );

  router.get(
    "/encounters/:id/notes",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(idParamSchema, "params"),
    validate(listNotesQuerySchema, "query"),
    responds(wardNote.array()),
    asyncHandler(controller.listNotes),
  );

  /** Writes the summary and ends the stay — the bed-days are billed from the event. */
  router.post(
    "/encounters/:id/discharge",
    authenticate(),
    authorize(PERMISSIONS.ADMISSION_DISCHARGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(dischargeSchema),
    responds(dischargeResult, { status: 201 }),
    asyncHandler(controller.discharge),
  );

  /**
   * Moves an admitted patient to another bed (B4). `bed:allocate` — the permission whose own
   * description is "Allocate and transfer beds"; the ward clerk / nurse who runs the board, not
   * necessarily the discharging doctor. The occupancy invariant is the encounter's; this records why.
   */
  router.post(
    "/encounters/:id/transfer-bed",
    authenticate(),
    authorize(PERMISSIONS.BED_ALLOCATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(transferBedSchema),
    responds(transferBedResult),
    asyncHandler(controller.transferBed),
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
    responds(outcomeResult, { status: 201 }),
    asyncHandler(controller.recordOutcome),
  );

  return router;
}
