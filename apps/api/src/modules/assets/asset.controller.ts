/**
 * Asset + maintenance controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as assets from "./asset.service.js";
import type {
  CreateAssetBody,
  UpdateAssetBody,
  AddMaintenanceBody,
  ListAssetsQuery,
} from "./asset.schema.js";
import { ok } from "../../core/http/respond.js";

export const listAssets: RequestHandler = async (req, res) => {
  ok(res, await assets.listAssets(req.query as ListAssetsQuery));
};

export const createAsset: RequestHandler = async (req, res) => {
  ok(res, await assets.createAsset(req.body as CreateAssetBody), 201);
};

export const updateAsset: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await assets.updateAsset(id, req.body as UpdateAssetBody));
};

export const listMaintenance: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await assets.listMaintenance(id));
};

export const addMaintenance: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await assets.addMaintenance(id, req.body as AddMaintenanceBody), 201);
};
