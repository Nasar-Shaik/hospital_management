/**
 * API-key controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as apiKeys from "./apiKey.service.js";
import type { CreateApiKeyBody } from "./apiKey.schema.js";
import { ok } from "../../core/http/respond.js";

export const list: RequestHandler = async (_req, res) => {
  ok(res, await apiKeys.listApiKeys());
};

/**
 * Creates a key. 201 with the FULL key in the body — the only time it is ever returned. The client
 * must show it to the user once and then it is gone.
 */
export const create: RequestHandler = async (req, res) => {
  const body = req.body as CreateApiKeyBody;
  ok(
    res,
    await apiKeys.createApiKey({
      name: body.name,
      // Parsed at the EDGE — the service takes a Date, never a string to parse.
      ...(body.expiresOn ? { expiresAt: new Date(`${body.expiresOn}T23:59:59.999Z`) } : {}),
    }),
    201,
  );
};

export const revoke: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await apiKeys.revokeApiKey(id));
};
