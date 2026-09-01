/**
 * Mortuary controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as mortuary from "./mortuary.service.js";
import type { ReceiveBodyBody, ReleaseBodyBody, ListQuery } from "./mortuary.schema.js";
import { ok } from "../../core/http/respond.js";

export const listRegister: RequestHandler = async (req, res) => {
  const { status } = req.query as ListQuery;
  ok(res, await mortuary.listRegister(status));
};

export const getForEncounter: RequestHandler = async (req, res) => {
  const { encounterId } = req.params as { encounterId: string };
  ok(res, (await mortuary.getEntryForEncounter(encounterId)) ?? null);
};

export const receiveBody: RequestHandler = async (req, res) => {
  ok(res, await mortuary.receiveBody(req.body as ReceiveBodyBody), 201);
};

export const releaseBody: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await mortuary.releaseBody(id, req.body as ReleaseBodyBody));
};
