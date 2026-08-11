/**
 * Patient routes (Doc 02 C1 pages: Registration, Patient Search, Merge).
 *
 * ── WHY THERE IS NO `feature:` GATE ON THESE ROUTES ──────────────────────────
 * Every other business router will carry one (`{ feature: FEATURE_FLAGS.OPS_… }`).
 * These do not, and the omission is deliberate rather than forgotten: there is no
 * edition of this product — not the smallest single-doctor clinic plan — in which
 * a hospital does not register patients. A flag whose answer is always "yes" is
 * not a switch, it is a bug waiting to lock someone out of the front desk.
 *
 * ── AND NO PLAN LIMIT ────────────────────────────────────────────────────────
 * `maxPatients` exists in the edition type and NO edition sets it. That stays true.
 * Seats, branches and beds are things a hospital buys; patients are people who
 * walk in. Refusing to register a sick person because the hospital is at 10,000
 * records on a Clinic plan would be the purest possible case of commercial
 * interest outranking a clinical one — which the decision log already forbids
 * (00-PROGRESS-TRACKER §5, 2026-07-14).
 *
 * ── THE PERMISSION SPLIT ─────────────────────────────────────────────────────
 * `patient:read` and `patient:register` are `branch`-scoped — a clerk sees and
 * creates within their own branch. `patient:merge` is TENANT-scoped and separate,
 * because merging is the one irreversible action here and it must not arrive free
 * with "can register a patient".
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./patient.controller.js";
import {
  duplicateCandidate,
  mergeResult,
  patient,
  registerPatientResult,
} from "./patient.contract.js";
import {
  duplicateCheckSchema,
  idParamSchema,
  listPatientsQuerySchema,
  mergePatientsSchema,
  registerPatientSchema,
  uhidParamSchema,
  updatePatientSchema,
} from "./patient.schema.js";

export function patientRouter(): Router {
  const router = Router();

  router.get(
    "/patients",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_READ),
    validate(listPatientsQuerySchema, "query"),
    responds(patient.array(), { meta: true }),
    asyncHandler(controller.listPatients),
  );

  /**
   * By UHID — the number the patient reads out at the desk or over the phone.
   * Declared BEFORE `/patients/:id` so `by-uhid` is not swallowed as an id.
   */
  router.get(
    "/patients/by-uhid/:uhid",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_READ),
    validate(uhidParamSchema, "params"),
    responds(patient),
    asyncHandler(controller.getPatientByUhid),
  );

  router.get(
    "/patients/:id",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_READ),
    validate(idParamSchema, "params"),
    responds(patient),
    asyncHandler(controller.getPatient),
  );

  router.post(
    "/patients",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_REGISTER),
    validate(registerPatientSchema),
    responds(registerPatientResult, { status: 201 }),
    idempotent("Replays the patient this key already registered."),
    asyncHandler(controller.registerPatient),
  );

  /**
   * The duplicate check the form runs before submitting. Gated on `patient:read`,
   * not `patient:register`: it RETURNS other patients' names, dates of birth and
   * phone numbers, so it is a read of PHI and must be authorized as one. Anyone
   * who can register can already read, so this costs nothing in practice — but
   * getting it the other way round would be a disclosure route hiding behind a
   * write permission.
   */
  router.post(
    "/patients/check-duplicates",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_READ),
    validate(duplicateCheckSchema),
    responds(duplicateCandidate.array()),
    asyncHandler(controller.checkDuplicates),
  );

  router.patch(
    "/patients/:id",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_UPDATE),
    validate(idParamSchema, "params"),
    validate(updatePatientSchema),
    responds(patient),
    asyncHandler(controller.updatePatient),
  );

  // Irreversible in practice. Its own permission, tenant-scoped, and it writes a
  // named audit entry with the operator's stated reason.
  router.post(
    "/patients/merge",
    authenticate(),
    authorize(PERMISSIONS.PATIENT_MERGE),
    validate(mergePatientsSchema),
    responds(mergeResult),
    asyncHandler(controller.mergePatients),
  );

  return router;
}
