/**
 * Site controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as site from "./site.service.js";
import type { UpdateSiteBody } from "./site.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/** PUBLIC — the hospital's website content. No auth; safe to show a stranger. */
export const publicSite: RequestHandler = async (_req, res) => {
  ok(res, await site.getPublicSite());
};

/** Admin — the saved fields, for the editor (blanks mean "not set"). */
export const getSettings: RequestHandler = async (_req, res) => {
  ok(res, await site.getEditableSite());
};

/** Admin — save edits. */
export const updateSettings: RequestHandler = async (req, res) => {
  const body = req.body as UpdateSiteBody;
  ok(res, await site.updateSite(body));
};
