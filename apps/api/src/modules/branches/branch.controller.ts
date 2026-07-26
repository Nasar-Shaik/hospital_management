/**
 * Branch controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as branches from "./branch.service.js";
import type { CreateBranchBody, UpdateBranchBody } from "./branch.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

/** The switcher's data — the caller's own branches + whether they may aggregate. Self-service. */
export const listMine: RequestHandler = async (_req, res) => {
  ok(res, await branches.listMyBranches());
};

/** The admin list — every branch of the hospital. */
export const list: RequestHandler = async (_req, res) => {
  ok(res, await branches.listBranches());
};

export const create: RequestHandler = async (req, res) => {
  ok(res, await branches.createBranch(req.body as CreateBranchBody), 201);
};

export const update: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await branches.updateBranch(id, req.body as UpdateBranchBody));
};
