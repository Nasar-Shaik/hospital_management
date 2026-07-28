/**
 * Hospital-profile controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as profile from "./hospitalProfile.service.js";
import type { SaveHospitalProfileBody } from "./hospitalProfile.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const getProfile: RequestHandler = async (_req, res) => {
  ok(res, await profile.getProfile());
};

export const saveProfile: RequestHandler = async (req, res) => {
  ok(res, await profile.saveProfile(req.body as SaveHospitalProfileBody));
};
