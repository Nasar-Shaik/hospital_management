/**
 * Notification controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import { AppError } from "../../core/errors/appError.js";
import * as notifications from "./notification.service.js";
import * as push from "./push.service.js";
import type {
  InboxQuery,
  ListNotificationsQuery,
  RegisterDeviceBody,
  UpdateTemplateBody,
} from "./notification.schema.js";
import { ok } from "../../core/http/respond.js";

/**
 * The delivery ledger. This screen exists to answer one question, asked at a front
 * desk with a patient on the phone: "did they get it?"
 */
export const listNotifications: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListNotificationsQuery;

  const { items, total } = await notifications.listNotifications({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.templateKey ? { templateKey: query.templateKey } : {}),
    ...(query.recipientId ? { recipientId: query.recipientId } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

/**
 * The caller's own inbox.
 *
 * The bell and the inbox are the SAME route. `?unread=true&limit=5` gives the badge its number
 * (`meta.total` under that filter is the unread count) and the dropdown its newest few, in one
 * request; the full page asks without the filter. Nothing here needed an endpoint of its own.
 */
export const inbox: RequestHandler = async (req, res) => {
  const query = req.query as unknown as InboxQuery;

  const { items, total } = await notifications.inbox({
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
    ...(query.unread ? { unreadOnly: true } : {}),
  });

  ok(res, items, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

/** Opening one message. Re-opening is not an error — it is the same fact, already recorded. */
export const markRead: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const message = await notifications.markRead(id);

  // Not yours, or no such message. Deliberately the same answer for both: telling a caller that a
  // message exists but belongs to someone else is more than they are entitled to know.
  if (!message) throw new AppError("HMS-GEN-404", 404, "No such message", { id });

  ok(res, message);
};

export const listTemplates: RequestHandler = async (_req, res) => {
  ok(res, await notifications.listTemplates());
};

export const updateTemplate: RequestHandler = async (req, res) => {
  const { key } = req.params as { key: string };
  const updated = await notifications.updateTemplate(key, req.body as UpdateTemplateBody);

  // A template that does not exist cannot be created here on the fly: the key is
  // what the CODE calls, so inventing one through the API produces a template that
  // nothing will ever render.
  if (!updated) throw new AppError("HMS-GEN-404", 404, "No such notification template", { key });

  ok(res, updated);
};

/* ── the caller's own handsets (M4) ───────────────────────────────────────── */

/**
 * Registers this phone for push. Called on every sign-in, not just the first.
 *
 * An UPSERT rather than a create, so it is safe to call on every bootstrap — which is what makes
 * the client simple: it never has to remember whether it has registered, and a token the OS
 * rotated replaces the old row instead of adding a second. 200, not 201, because "your phone is
 * registered" is the outcome either way and the client has nothing to do differently.
 */
export const registerDevice: RequestHandler = async (req, res) => {
  const body = req.body as RegisterDeviceBody;
  ok(res, await push.registerDevice(body));
};

/** The caller's own handsets. Useful to a person asking "where do my alerts go?". */
export const listDevices: RequestHandler = async (_req, res) => {
  ok(res, await push.listOwnDevices());
};

/**
 * Retires one handset — the sign-out half of the lifecycle.
 *
 * A 404 when it is not theirs, deliberately not a 403: telling a caller "that device exists but
 * belongs to somebody else" answers a question they had no business asking. The repository puts
 * `userId` in the filter, so the two cases are indistinguishable by construction rather than by
 * this handler remembering to conflate them.
 */
export const releaseDevice: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const released = await push.releaseDevice(id);
  if (!released) throw new AppError("HMS-GEN-404", 404, "No such device");
  ok(res, { released: true });
};
