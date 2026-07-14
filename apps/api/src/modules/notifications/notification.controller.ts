/**
 * Notification controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import * as notifications from "./notification.service.js";
import type { ListNotificationsQuery, UpdateTemplateBody } from "./notification.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

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
