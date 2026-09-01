/**
 * Hospital-profile controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as profile from "./hospitalProfile.service.js";
import type { SaveHospitalProfileBody } from "./hospitalProfile.schema.js";
import { ok } from "../../core/http/respond.js";

export const getProfile: RequestHandler = async (_req, res) => {
  ok(res, await profile.getProfile());
};

export const saveProfile: RequestHandler = async (req, res) => {
  ok(res, await profile.saveProfile(req.body as SaveHospitalProfileBody));
};
