/**
 * Ward & bed controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as wards from "./ward.service.js";
import type {
  CreateWardBody,
  UpdateWardBody,
  CreateBedBody,
  UpdateBedBody,
  ListBedsQuery,
} from "./ward.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const listWards: RequestHandler = async (_req, res) => {
  ok(res, await wards.listWards());
};

export const createWard: RequestHandler = async (req, res) => {
  ok(res, await wards.createWard(req.body as CreateWardBody), 201);
};

export const updateWard: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wards.updateWard(id, req.body as UpdateWardBody));
};

export const listBeds: RequestHandler = async (req, res) => {
  const { wardId } = req.query as ListBedsQuery;
  ok(res, await wards.listBeds(wardId));
};

export const createBed: RequestHandler = async (req, res) => {
  ok(res, await wards.createBed(req.body as CreateBedBody), 201);
};

export const updateBed: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await wards.updateBed(id, req.body as UpdateBedBody));
};
