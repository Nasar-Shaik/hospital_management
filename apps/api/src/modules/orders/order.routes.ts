/**
 * Order routes (ADR-0013 §3).
 *
 * ── GATED ON `module.ops.opd` ───────────────────────────────────────────────
 * Not on the lab module, and not on radiology. A hospital that has bought neither
 * still orders tests — it sends them to an outside lab and types the result back in,
 * and that is the normal state of affairs for a small clinic. Gating the ORDER on the
 * DESTINATION would mean a clinic cannot record that it asked for a blood test, which
 * is not a cheaper product; it is a chart with a hole in it.
 *
 * ── THE PERMISSION SPLIT IS A PATIENT-SAFETY BOUNDARY ───────────────────────
 * `order:create`  — the doctor asks.
 * `order:perform` — the technician does it and records the number.
 * `order:verify`  — a SECOND, QUALIFIED person certifies it (plus category authority:
 *                   see order.authority.ts — a pathologist may not sign off a CT).
 * `order:release` — the result is disclosed to the doctor and the patient.
 *
 * A doctor holds none of the last three. A doctor who could verify their own order
 * would be the only pair of eyes on it, and the second pair of eyes is the entire
 * mechanism by which a wrong number is caught before somebody acts on it.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./order.controller.js";
import {
  cancelOrderSchema,
  completeOrderSchema,
  idParamSchema,
  listOrdersQuerySchema,
  placeOrderSchema,
} from "./order.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.OPS_OPD } as const;

export function orderRouter(): Router {
  const router = Router();

  /** A doctor asks for something. This event IS the hand-off to the department. */
  router.post(
    "/orders",
    authenticate(),
    authorize(PERMISSIONS.ORDER_CREATE, FEATURE),
    validate(placeOrderSchema),
    asyncHandler(controller.placeOrder),
  );

  /** `?category=lab&outstanding=true` is the lab's worklist. */
  router.get(
    "/orders",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    validate(listOrdersQuerySchema, "query"),
    asyncHandler(controller.listOrders),
  );

  router.get(
    "/orders/:id",
    authenticate(),
    authorize(PERMISSIONS.ORDER_READ, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.getOrder),
  );

  /* ── the state machine (STATE_MACHINE_CATALOG §15) ────────────────────────── */

  router.post(
    "/orders/:id/accept",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.acceptOrder),
  );

  router.post(
    "/orders/:id/start",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.startOrder),
  );

  /**
   * The work is done and the number exists.
   *
   * If it is flagged `critical`, the alert goes out from HERE — synchronously, before
   * verification and long before release. A potassium of 7.2 does not wait for a
   * pathologist to come back from lunch.
   */
  router.post(
    "/orders/:id/complete",
    authenticate(),
    authorize(PERMISSIONS.ORDER_PERFORM, FEATURE),
    validate(idParamSchema, "params"),
    validate(completeOrderSchema),
    asyncHandler(controller.completeOrder),
  );

  /** The second pair of eyes. Requires authority over the CATEGORY, not just the verb. */
  router.post(
    "/orders/:id/verify",
    authenticate(),
    authorize(PERMISSIONS.ORDER_VERIFY, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.verifyOrder),
  );

  /**
   * The result reaches the doctor who asked, and the patient stops waiting.
   *
   * Separate from `verify` because a result can be clinically correct and still not
   * ready to be seen — an HIV result is given with counselling, not by a portal
   * notification at 2am. Verification is a clinical act; release is a disclosure.
   */
  router.post(
    "/orders/:id/release",
    authenticate(),
    authorize(PERMISSIONS.ORDER_RELEASE, FEATURE),
    validate(idParamSchema, "params"),
    asyncHandler(controller.releaseOrder),
  );

  router.post(
    "/orders/:id/cancel",
    authenticate(),
    authorize(PERMISSIONS.ORDER_CANCEL, FEATURE),
    validate(idParamSchema, "params"),
    validate(cancelOrderSchema),
    asyncHandler(controller.cancelOrder),
  );

  return router;
}
