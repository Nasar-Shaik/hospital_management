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
import { responds } from "../../middleware/responds.js";
import * as controller from "./notification.controller.js";
import { inboxMessage, notification, notificationTemplate } from "./notification.contract.js";
import {
  inboxQuerySchema,
  notificationIdParamSchema,
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
  /**
   * ── THE PERSON'S OWN INBOX ──────────────────────────────────────────────────
   * Authenticated, and DELIBERATELY UNPERMISSIONED. The recipient is taken from the session and
   * cannot be named in the query, so there is nothing here a caller could over-reach for: the
   * route can only ever return what the domain already decided to send to them.
   *
   * A permission would be actively harmful. Every role in a hospital receives messages — the
   * technician gets none today and will get stock alerts tomorrow — so gating this would mean any
   * hospital that built its own role from scratch would have staff who cannot read their own
   * alerts, and the symptom would be an inbox that is simply always empty. Same reasoning, and
   * the same list in `rbac.int.test.ts`, as `GET /reports/my-activity` and `GET /me/branches`.
   *
   * It must be declared in that suite's `SELF_SERVICE_ROUTES` — "no permission" has to be a
   * decision somebody wrote down, never a line somebody forgot.
   */
  router.get(
    "/notifications/me",
    authenticate(),
    validate(inboxQuerySchema, "query"),
    responds(inboxMessage.array(), { meta: true }),
    asyncHandler(controller.inbox),
  );

  /**
   * Opening one. Not `idempotent()` — that middleware replays a stored RESPONSE for a client
   * retrying one intent, and this needs something stronger and cheaper: the write itself only
   * matches an unread row, so a second call is a no-op that returns the same message with the
   * original `readAt` intact. Idempotent by the query, for every caller, forever — not just for
   * the one that remembered to send a key.
   */
  router.post(
    "/notifications/:id/read",
    authenticate(),
    validate(notificationIdParamSchema, "params"),
    responds(inboxMessage),
    asyncHandler(controller.markRead),
  );

  router.get(
    "/notifications",
    authenticate(),
    authorize(PERMISSIONS.NOTIFICATION_MANAGE),
    validate(listNotificationsQuerySchema, "query"),
    responds(notification.array(), { meta: true }),
    asyncHandler(controller.listNotifications),
  );

  router.get(
    "/notifications/templates",
    authenticate(),
    authorize(PERMISSIONS.NOTIFICATION_MANAGE),
    responds(notificationTemplate.array()),
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
    responds(notificationTemplate),
    asyncHandler(controller.updateTemplate),
  );

  return router;
}
