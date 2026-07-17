/**
 * Notification routes (Doc 02 A6).
 *
 * ── NO FEATURE FLAG, ON PURPOSE ──────────────────────────────────────────────
 * Appointments carries `module.ops.appointments` because a diagnostic lab does not
 * buy an appointment book. Notifications is not that kind of module: EVERY edition
 * sends messages, and an edition that could not tell a patient their appointment
 * moved would be a broken product, not a cheaper one. Gating it would be inventing
 * an upsell out of a thing that makes the software work at all.
 *
 * ── WHY THERE IS NO `POST /notifications` ────────────────────────────────────
 * `notification:send` exists in the permission catalog and no route uses it yet,
 * and that is a deliberate absence, not an oversight. A general "send an arbitrary
 * message to an arbitrary person" endpoint is a spam cannon with a REST interface —
 * and the first thing anyone builds on top of a hospital's patient list. Messages
 * are sent by the domain, in response to something that actually happened, and the
 * ledger records why. When a real use case arrives (a broadcast to a ward, a recall
 * of a batch of patients), it gets its own endpoint with its own audit story.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./notification.controller.js";
import {
  listNotificationsQuerySchema,
  templateKeyParamSchema,
  updateTemplateSchema,
} from "./notification.schema.js";

export function notificationRouter(): Router {
  const router = Router();

  /**
   * The ledger contains message bodies, and a message body contains a patient's
   * name, their doctor and their appointment time — PHI. So this is
   * `notification:manage` (an administrative permission), NOT something every
   * clerk holds by default.
   */
  router.get(
    "/notifications",
    authenticate(),
    authorize(PERMISSIONS.NOTIFICATION_MANAGE),
    validate(listNotificationsQuerySchema, "query"),
    asyncHandler(controller.listNotifications),
  );

  router.get(
    "/notifications/templates",
    authenticate(),
    authorize(PERMISSIONS.NOTIFICATION_MANAGE),
    asyncHandler(controller.listTemplates),
  );

  /**
   * The hospital rewrites the words its patients read. That is theirs to own — our
   * defaults are a starting point, not a house style.
   *
   * Editing marks the template as no longer default, which is what stops a later
   * seed run from quietly reverting their words back to ours.
   */
  router.put(
    "/notifications/templates/:key",
    authenticate(),
    authorize(PERMISSIONS.NOTIFICATION_MANAGE),
    validate(templateKeyParamSchema, "params"),
    validate(updateTemplateSchema),
    asyncHandler(controller.updateTemplate),
  );

  return router;
}
