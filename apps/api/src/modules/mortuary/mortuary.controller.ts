/**
 * Mortuary controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as mortuary from "./mortuary.service.js";
import type { ReceiveBodyBody, ReleaseBodyBody, ListQuery } from "./mortuary.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

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
