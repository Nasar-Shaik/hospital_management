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
 * `emr:write`  — write a MEDICAL ward note, and reach the discharge/outcome documents that
 *                share this router. Doctors.
 * `nursing:manage` — write a NURSING note (M3-S2). A separate route, deliberately.
 * `emr:read`   — read the chart. Everyone clinical, including the pharmacist.
 * `admission:discharge` — end the stay. A clinical decision, DOCTOR only. Deliberately
 *                not `emr:write`: writing the summary and deciding the patient is well
 *                enough to leave are different acts, and only one of them is a judgement.
 *
 * ── A CORRECTION WORTH KEEPING ──────────────────────────────────────────────
 * This header used to say `emr:write` was for "doctors and (later) nurses… and NURSE already
 * holds it". **NURSE does not hold `emr:write`** — computed from `DEFAULT_ROLES`, not eyeballed.
 * That sentence is most likely why nobody noticed a nurse could not write a single note for the
 * whole life of the module: the comment asserted the capability existed, so nothing tested it.
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
  medicationRoundRow,
  outcomeResult,
  transferBedResult,
  wardNote,
  worklistRow,
} from "./admission.contract.js";
import {
  addNoteSchema,
  addNursingNoteSchema,
  dischargeSchema,
  medicationRoundQuerySchema,
  outcomeSchema,
  idParamSchema,
  listNotesQuerySchema,
  transferBedSchema,
  worklistQuerySchema,
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
   * The ward worklist (M3-S3) — one page of admitted patients with allergy and due-dose state.
   *
   * `emr:read`, the general clinical read. It grants no new reach: every field is already
   * readable through `/inpatients`, `/patients/:id/allergies` and the MAR endpoints by anyone
   * holding it. What this adds is that a twenty-bed ward costs four queries instead of sixty-one.
   *
   * Paged with the same `page`/`limit`/`meta.total` contract as every other list, so "is there
   * more?" has the same answer everywhere and no client needs a second dialect.
   */
  router.get(
    "/ward-worklist",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(worklistQuerySchema, "query"),
    responds(worklistRow.array(), { meta: true }),
    asyncHandler(controller.getWorklist),
  );

  /**
   * The medication round (M3-S5B) — one page of the ward with every dose expected today.
   *
   * ── GATED ON `module.clinical.nursing`, NOT `module.ops.ipd` LIKE ITS NEIGHBOURS ──
   * The only route in this router that is. It is a MAR surface: it returns dose slots, which is
   * exactly what `/encounters/:id/medication-schedule` returns and exactly what the nursing flag
   * gates there. Gating it on beds instead would let a hospital that never bought the medication
   * record read the medication record through this door, one ward at a time — an entitlement
   * bypass, and a silent one. A tenant with no beds and the nursing module simply has nobody
   * admitted, which the empty page says honestly.
   *
   * `emr:read`, like `/ward-worklist` and the schedule endpoint it composes. It grants no new
   * reach: every field here is already readable by anyone holding `emr:read`, through
   * `/ward-worklist`, `/bed-board`, `/patients/:id/allergies` and one schedule call per patient.
   * What it adds is that a twenty-bed round costs five queries instead of sixty-three. A stricter
   * permission would deny the doctor reviewing the round a view they can already assemble with a
   * loop, which is not a boundary — it is a speed bump with a clinical cost. The boundary that
   * matters is on the WRITE, and that is `mar:administer` (M3-S5A), unchanged.
   */
  router.get(
    "/medication-round",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, { feature: FEATURE_FLAGS.CLINICAL_NURSING }),
    validate(medicationRoundQuerySchema, "query"),
    responds(medicationRoundRow.array(), { meta: true }),
    asyncHandler(controller.getMedicationRound),
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

  /**
   * ── THE NURSE'S OWN ENTRY (M3-S2) ───────────────────────────────────────────
   * A nurse could not write any note at all before this: the sibling route above requires
   * `emr:write`, which NURSE does not hold, and granting it would also open `discharge_summary`
   * and `outcome_note` — a doctor's record and a statutory account of a death.
   *
   * `nursing:manage` instead. That permission was granted to NURSE and gated NOTHING until now,
   * which is the same "a permission nobody's request reaches is a feature nobody has" trap the
   * roster had. `authorize()` takes one permission and the RBAC matrix reads the tags back off
   * the shipped app, so a second permission on the existing route is not expressible — a separate
   * path is.
   *
   * Same collection, `type: "nursing"` set by the service. The DTO has no `type` field and is
   * `.strict()`, so this endpoint cannot be talked into writing any other kind of note.
   *
   * `idempotent()` last, after `validate`, exactly as the ward note does: a note is append-only
   * with no delete path, so a retry on ward wifi would otherwise leave two identical entries on a
   * medico-legal record for ever.
   */
  router.post(
    "/encounters/:id/nursing-notes",
    authenticate(),
    authorize(PERMISSIONS.NURSING_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(addNursingNoteSchema),
    responds(wardNote, { status: 201 }),
    idempotent("Replays the nursing note this key already wrote."),
    asyncHandler(controller.addNursingNote),
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
