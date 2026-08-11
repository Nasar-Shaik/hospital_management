/**
 * Subscription controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import type { FeatureFlag } from "@medicore/permissions";
import { getContext } from "../../core/context/requestContext.js";
import { setFeatureOverride as setOverride } from "../entitlements/index.js";
import * as service from "./subscription.service.js";
import { ok } from "../../core/http/respond.js";

export const getSubscription: RequestHandler = async (_req, res) => {
  ok(res, await service.getSubscription(getContext().tenantId));
};

export const listPlans: RequestHandler = async (_req, res) => {
  ok(res, await service.listPlans());
};

export const changePlan: RequestHandler = async (req, res) => {
  const { planCode } = req.body as { planCode: string };
  ok(res, await service.changePlan(getContext().tenantId, planCode));
};

export const setFeatureOverride: RequestHandler = async (req, res) => {
  const { flag, enabled, reason, expiresAt } = req.body as {
    flag: string;
    enabled: boolean;
    reason: string;
    expiresAt?: string;
  };

  await setOverride({
    tenantId: getContext().tenantId,
    flag: flag as FeatureFlag,
    enabled,
    reason,
    ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
  });

  ok(res, await service.getSubscription(getContext().tenantId));
};
