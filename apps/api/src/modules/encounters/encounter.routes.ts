/**
 * Encounter routes (Doc 02 E0, ADR-0013) — the front door of the product.
 *
 * ── GATED ON `module.ops.opd`, NOT ON `module.ops.appointments` ──────────────
 * That unbundling is the whole point. A government hospital buys OPD and never
 * books an appointment in its life; a diagnostic centre takes walk-ins holding a
 * prescription written somewhere else. Under the old model they had to enable an
 * appointment book they would never open, just to put a patient in a queue.
 *
 * Every edition carries the flag. A hospital that cannot admit a patient to a queue
 * is not a cheaper product — it is a broken one.
 *
 * ── THE PERMISSION SPLIT IS A SAFETY BOUNDARY, NOT BUREAUCRACY ──────────────
 * `encounter:create` belongs to the front desk. A DOCTOR does not have it: a doctor
 * who can conjure a visit out of nothing can see a patient who was never registered
 * — which means no UHID, no queue position, and no bill. The desk starts visits;
 * clinicians move them.
 *
 * `encounter:close` is separate from `encounter:update` because closing freezes what
 * can be billed against the visit and asserts the consultation happened. A nurse
 * moves patients along; she does not declare them finished.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./encounter.controller.js";
import {
  admitResult,
  encounter,
  encounterRow,
  inpatientRow,
  startEncounterResult,
} from "./encounter.contract.js";
import {
  admitSchema,
  transferSchema,
  cancelEncounterSchema,
  closeEncounterSchema,
  idParamSchema,
  listEncountersQuerySchema,
  listInpatientsQuerySchema,
  startEncounterSchema,
  visitSummarySchema,
} from "./encounter.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;
/**
 * Beds are a separate purchase. A clinic and a diagnostic centre have no wards, and their
 * editions do not carry this — so the admit routes answer "not in your edition"
 * (HMS-PLAN-002), which is the truth and has a remedy, rather than a permission error that
 * no amount of role editing could ever fix.
 */
const IPD_FEATURE = { feature: FEATURE_FLAGS.OPS_IPD } as const;

export function encounterRouter(): Router {
  const router = Router();

  /** A patient arrives — booked, walked in, or brought in. */
  router.post(
    "/encounters",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_CREATE, FEATURE),
    validate(startEncounterSchema),
    responds(startEncounterResult, { status: [200, 201] }),
    idempotent("Replays the visit this key already opened."),
    asyncHandler(controller.startEncounter),
  );

  /**
   * The queue board AND the doctor's day, from one endpoint: `?queued=true` is
   * everyone currently waiting or being seen, in TOKEN order — which is arrival
   * order, which is the only order a waiting room accepts as fair.
   */
  router.get(
    "/encounters",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(listEncountersQuerySchema, "query"),
    // `encounterRow`, not `encounter`: a list of visits is a screen somebody reads, and every one
    // of its consumers had to turn `patientId` into a name somehow (D18, see the contract).
    responds(encounterRow.array(), { meta: true }),
    asyncHandler(controller.listEncounters),
  );

  router.get(
    "/encounters/:id",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter),
    asyncHandler(controller.getEncounter),
  );

  /**
   * The care story. Declared here rather than under `/episodes` because it is the
   * same permission and the same module — and because the thing a doctor actually
   * asks for is "everything about this visit's history", not "an episode resource".
   */
  router.get(
    "/episodes/:id/timeline",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter.array()),
    asyncHandler(controller.getEpisodeTimeline),
  );

  /**
   * Everyone in a bed right now. Gated on `module.ops.ipd` — a clinic has no wards, and
   * the honest answer to a clinic asking for its ward list is "you did not buy one".
   *
   * Paged like every other list here. The default `limit` is 100 rather than the usual 20
   * precisely so this stays backward compatible: that is what the controller hard-coded before
   * there was a query schema, and shrinking an existing client's ward list would be the same
   * "patients vanish" bug seen from the other side (`listInpatientsQuerySchema`).
   */
  router.get(
    "/inpatients",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_READ, IPD_FEATURE),
    validate(listInpatientsQuerySchema, "query"),
    responds(inpatientRow.array(), { meta: true }),
    asyncHandler(controller.listInpatients),
  );

  /* ── the state machine (STATE_MACHINE_CATALOG §14) ───────────────────────── */

  /**
   * Admit: the OP encounter closes (`admitted`) and an INPATIENT one opens in the same
   * Episode of Care (ADR-0013 §4).
   *
   * `admission:create`, not `encounter:update` — deciding a patient needs a bed is a
   * clinical judgement, and it is the DOCTOR's. Held by nobody at all until this slice,
   * which is why every admit route would have 403'd for every human in the building.
   *
   * Gated on `module.ops.ipd`: a clinic with no beds gets "not in your edition", which is
   * the truth, rather than a permission error that no role edit could ever fix.
   */
  router.post(
    "/encounters/:id/admit",
    authenticate(),
    authorize(PERMISSIONS.ADMISSION_CREATE, IPD_FEATURE),
    validate(idParamSchema, "params"),
    validate(admitSchema),
    responds(admitResult, { status: 201 }),
    idempotent("Replays the admission this key already made."),
    asyncHandler(controller.admitPatient),
  );

  /**
   * Hand the patient to another doctor.
   *
   * `encounter:update` — the same permission that moves a patient through the queue, and
   * for the same reason: this changes who the patient is waiting for, not what has been
   * decided about them. A nurse re-routing a mis-assigned walk-in is doing their job.
   *
   * Gated on OPD (the base flag), not IPD: transferring a case is an outpatient act far
   * more often than an inpatient one.
   */
  router.post(
    "/encounters/:id/transfer",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(transferSchema),
    responds(encounter),
    asyncHandler(controller.transferDoctor),
  );

  router.post(
    "/encounters/:id/queue",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter),
    asyncHandler(controller.queuePatient),
  );

  router.post(
    "/encounters/:id/start",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter),
    asyncHandler(controller.startConsultation),
  );

  /**
   * Sent for tests. THE PATIENT KEEPS THIS ENCOUNTER — that is the entire reason
   * this route exists rather than closing the visit and opening a new one when they
   * come back. Re-registering the returning patient is the commonest data-quality
   * disaster in an OPD.
   */
  router.post(
    "/encounters/:id/investigations",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter),
    asyncHandler(controller.sendForInvestigations),
  );

  router.post(
    "/encounters/:id/close",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_CLOSE, FEATURE),
    validate(idParamSchema, "params"),
    validate(closeEncounterSchema),
    responds(encounter),
    asyncHandler(controller.closeEncounter),
  );

  /**
   * The doctor's OP visit summary (diagnosis / advice) for the OPD slip. `emr:write` — it is
   * clinical documentation, the same authority as a ward note, not queue management.
   */
  router.post(
    "/encounters/:id/summary",
    authenticate(),
    authorize(PERMISSIONS.EMR_WRITE, FEATURE),
    validate(idParamSchema, "params"),
    validate(visitSummarySchema),
    responds(encounter),
    asyncHandler(controller.recordVisitSummary),
  );

  router.post(
    "/encounters/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(cancelEncounterSchema),
    responds(encounter),
    asyncHandler(controller.cancelEncounter),
  );

  /**
   * They waited and left. Distinct from `cancelled` on purpose: a rising
   * left-without-being-seen count is a queue that is too slow, and it is one of the
   * few numbers that predicts a patient coming back sicker. A hospital that cannot
   * see it cannot fix it.
   */
  router.post(
    "/encounters/:id/left",
    authenticate(),
    authorize(PERMISSIONS.ENCOUNTER_UPDATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(encounter),
    asyncHandler(controller.markLeftWithoutBeingSeen),
  );

  return router;
}
