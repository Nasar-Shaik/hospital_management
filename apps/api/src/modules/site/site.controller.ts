/**
 * Site controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as site from "./site.service.js";
import type { UpdateSiteBody, UploadLogoBody } from "./site.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/** PUBLIC — the hospital's website content. No auth; safe to show a stranger. */
export const publicSite: RequestHandler = async (_req, res) => {
  ok(res, await site.getPublicSite());
};

/**
 * PUBLIC — the hospital's logo bytes. No auth: the login page (logged out) and the public site
 * both show it. Streamed as an image, not enveloped; a 404 when none is set is normal, not an error
 * the client should surface — it simply falls back to the name.
 */
export const publicLogo: RequestHandler = async (_req, res) => {
  const logo = await site.getLogo();
  if (!logo) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", logo.contentType);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(logo.data);
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

/** Admin — upload/replace the logo. */
export const uploadLogo: RequestHandler = async (req, res) => {
  const body = req.body as UploadLogoBody;
  await site.setLogo(body.contentType, body.dataBase64);
  ok(res, { uploaded: true });
};

/** Admin — remove the logo. */
export const deleteLogo: RequestHandler = async (_req, res) => {
  await site.clearLogo();
  ok(res, { deleted: true });
};
