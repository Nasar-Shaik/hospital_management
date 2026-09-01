/**
 * Insurance controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as insurance from "./insurance.service.js";
import type {
  CreatePolicyBody,
  UpdatePolicyBody,
  CreateClaimBody,
  TransitionClaimBody,
  SettleClaimBody,
} from "./insurance.schema.js";
import { ok } from "../../core/http/respond.js";

export const listPolicies: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await insurance.listPolicies(patientId));
};

export const linkPolicy: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await insurance.linkPolicy({ patientId, ...(req.body as CreatePolicyBody) }), 201);
};

export const updatePolicy: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await insurance.updatePolicy(id, req.body as UpdatePolicyBody));
};

export const listClaims: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await insurance.listClaims(patientId));
};

export const fileClaim: RequestHandler = async (req, res) => {
  const { patientId } = req.params as { patientId: string };
  ok(res, await insurance.fileClaim({ patientId, ...(req.body as CreateClaimBody) }), 201);
};

export const transitionClaim: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { to, approvedAmount, note } = req.body as TransitionClaimBody;
  ok(res, await insurance.transitionClaim(id, to, { approvedAmount, note }));
};

export const settleClaim: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { settledAmount, note } = req.body as SettleClaimBody;
  ok(res, await insurance.settleClaim(id, { settledAmount, note }));
};
