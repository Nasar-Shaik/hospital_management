/**
 * Prescription routes (STATE_MACHINE_CATALOG §6).
 *
 * ── GATED ON `module.ops.opd` ───────────────────────────────────────────────
 * Prescribing is part of seeing a patient, not a module a hospital buys separately. Every
 * edition has OPD; a doctor who can consult and cannot prescribe is not a cheaper product.
 * DISPENSING is the thing that is bought separately (`pharmacy.routes.ts`) — a clinic that
 * sends patients to the chemist next door still writes prescriptions all day.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * `prescription:create` — compose and edit a DRAFT. Binds nobody.
 * `prescription:sign`   — the signature. Deliberately separate, and it is the whole
 *                         point of the pair: signing is the act that makes a document a
 *                         legal authority for a drug to leave a shelf. A future intern or
 *                         junior-doctor role composes; only a licensed prescriber signs.
 * `emr:read`            — READING one. Held by doctors, nurses, pharmacists,
 *                         pathologists and radiologists: a prescription is part of the
 *                         clinical chart, and everyone who reads the chart reads it.
 *                         There is deliberately no `prescription:read` — inventing a
 *                         permission that would be granted to exactly the same set of
 *                         roles as an existing one buys nothing and adds a way to get the
 *                         grant wrong.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./prescription.controller.js";
import { prescription, prescriptionScreening } from "./prescription.contract.js";
import {
  cancelPrescriptionSchema,
  createPrescriptionSchema,
  idParamSchema,
  listPrescriptionsQuerySchema,
  signPrescriptionSchema,
  updatePrescriptionSchema,
} from "./prescription.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function prescriptionRouter(): Router {
  const router = Router();

  router.post(
    "/prescriptions",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_CREATE, FEATURE),
    validate(createPrescriptionSchema),
    responds(prescription, { status: 201 }),
    idempotent("Replays the prescription this key already wrote."),
    asyncHandler(controller.createPrescription),
  );

  /**
   * The chart's view, and the pharmacy's.
   *
   * `emr:read` rather than `prescription:create`, because the people who most need to READ
   * a prescription — the pharmacist about to hand the drugs over, the nurse about to give
   * them — must never be able to WRITE one.
   */
  router.get(
    "/prescriptions",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(listPrescriptionsQuerySchema, "query"),
    responds(prescription.array(), { meta: true }),
    asyncHandler(controller.listPrescriptions),
  );

  router.get(
    "/prescriptions/:id",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(prescription),
    asyncHandler(controller.getPrescription),
  );

  /** Drafts only. The service refuses a signed one and names the amend path. */
  router.patch(
    "/prescriptions/:id",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_CREATE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updatePrescriptionSchema),
    responds(prescription),
    asyncHandler(controller.updatePrescription),
  );

  /**
   * The live safety screen: the pad's read-only "is this safe to sign?" check.
   *
   * `emr:read`, not `prescription:sign` — a nurse or pharmacist looking at the chart may see
   * the same alerts the prescriber does. It signs nothing; it only reports.
   */
  router.get(
    "/prescriptions/:id/screen",
    authenticate(),
    authorize(PERMISSIONS.EMR_READ, FEATURE),
    validate(idParamSchema, "params"),
    responds(prescriptionScreening),
    asyncHandler(controller.screenPrescription),
  );

  /** The moment the document becomes real, and the pharmacy hears about it. */
  router.post(
    "/prescriptions/:id/sign",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_SIGN, FEATURE),
    validate(idParamSchema, "params"),
    validate(signPrescriptionSchema),
    responds(prescription),
    asyncHandler(controller.signPrescription),
  );

  /**
   * Stopping a drug requires `prescription:sign`, NOT `prescription:create`.
   *
   * STATE_MACHINE_CATALOG §6: "doctor only". Stopping an anticoagulant is as much a
   * prescribing decision as starting one, and gating it on the composing permission would
   * let whoever can type a draft also stop a drug somebody licensed put the patient on.
   */
  router.post(
    "/prescriptions/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_SIGN, FEATURE),
    validate(idParamSchema, "params"),
    validate(cancelPrescriptionSchema),
    responds(prescription),
    asyncHandler(controller.cancelPrescription),
  );

  /** Binning a draft. Nothing was ever authorised, so `create` is enough. */
  router.post(
    "/prescriptions/:id/discard",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_CREATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(prescription),
    asyncHandler(controller.discardPrescription),
  );

  /**
   * Changing a signed prescription: a new DRAFT that supersedes it.
   *
   * `create`, not `sign` — this only produces a draft, and the draft still has to be
   * signed by somebody who holds `prescription:sign` before it authorises anything.
   */
  router.post(
    "/prescriptions/:id/amend",
    authenticate(),
    authorize(PERMISSIONS.PRESCRIPTION_CREATE, FEATURE),
    validate(idParamSchema, "params"),
    responds(prescription, { status: 201 }),
    asyncHandler(controller.amendPrescription),
  );

  return router;
}
