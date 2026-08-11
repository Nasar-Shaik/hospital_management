/**
 * Feedback & complaint routes (Module B10).
 *
 * ── NO FEATURE FLAG ─────────────────────────────────────────────────────────
 * Every hospital, of every edition, receives compliments and complaints — a clinic no less than a
 * multi-branch group. Like `departments` and `branches`, the entity is part of every edition, so
 * the router is not feature-gated.
 *
 * ── THE PERMISSION SPLIT ────────────────────────────────────────────────────
 * LOG + READ (`feedback:manage`)  — record a compliment or complaint, and read the register. The
 *                          front-office / quality-desk act of TAKING what a patient says. Both kinds
 *                          share this door because logging is logging, whichever it turns out to be.
 * RESOLVE (`complaint:manage`) — assign a ticket and move it through its lifecycle. The
 *                          accountable act of WORKING a grievance to a close; a resolver holds both,
 *                          a receptionist who only takes feedback holds just the first. TENANT_ADMIN
 *                          holds both.
 */
import { Router } from "express";
import { PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import * as controller from "./feedback.controller.js";
import { feedbackTicket } from "./feedback.contract.js";
import {
  createTicketSchema,
  listTicketsQuerySchema,
  assignTicketSchema,
  transitionTicketSchema,
  idParamSchema,
} from "./feedback.schema.js";

export function feedbackRouter(): Router {
  const router = Router();

  router.get(
    "/feedback",
    authenticate(),
    authorize(PERMISSIONS.FEEDBACK_MANAGE),
    validate(listTicketsQuerySchema, "query"),
    responds(feedbackTicket.array()),
    asyncHandler(controller.listTickets),
  );

  router.post(
    "/feedback",
    authenticate(),
    authorize(PERMISSIONS.FEEDBACK_MANAGE),
    validate(createTicketSchema),
    responds(feedbackTicket, { status: 201 }),
    asyncHandler(controller.createTicket),
  );

  router.get(
    "/feedback/:id",
    authenticate(),
    authorize(PERMISSIONS.FEEDBACK_MANAGE),
    validate(idParamSchema, "params"),
    responds(feedbackTicket),
    asyncHandler(controller.getTicket),
  );

  router.post(
    "/feedback/:id/assign",
    authenticate(),
    authorize(PERMISSIONS.COMPLAINT_MANAGE),
    validate(idParamSchema, "params"),
    validate(assignTicketSchema),
    responds(feedbackTicket),
    asyncHandler(controller.assignTicket),
  );

  router.post(
    "/feedback/:id/transition",
    authenticate(),
    authorize(PERMISSIONS.COMPLAINT_MANAGE),
    validate(idParamSchema, "params"),
    validate(transitionTicketSchema),
    responds(feedbackTicket),
    asyncHandler(controller.transitionTicket),
  );

  return router;
}
