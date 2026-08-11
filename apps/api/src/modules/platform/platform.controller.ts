/**
 * Platform controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { requireOperator } from "../../middleware/authenticatePlatform.js";
import type { TenantStatus } from "../tenants/index.js";
import type { PlatformRole } from "./platform.model.js";
import * as service from "./platform.service.js";
import { ok } from "../../core/http/respond.js";

/** Everything an audited platform action needs to know about the caller. */
function actorOf(req: Parameters<RequestHandler>[0]) {
  const operator = requireOperator(req);
  return {
    actor: { id: operator.id, email: operator.email },
    context: {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {}),
    },
  };
}

export const login: RequestHandler = async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  ok(
    res,
    await service.loginOperator(email, password, {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.traceId ? { traceId: req.traceId } : {}),
    }),
  );
};

export const logout: RequestHandler = async (req, res) => {
  const operator = requireOperator(req);
  await service.logoutOperator(operator.jti, operator.expiresAt);
  ok(res, { loggedOut: true });
};

export const me: RequestHandler = (req, res) => {
  const operator = requireOperator(req);
  ok(res, { id: operator.id, email: operator.email, roles: operator.roles });
};

export const changePassword: RequestHandler = async (req, res) => {
  const operator = requireOperator(req);
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };
  await service.changeOperatorPassword(operator.id, currentPassword, newPassword);
  ok(res, { passwordChanged: true });
};

/* ── the fleet ────────────────────────────────────────────────────────────── */

export const listHospitals: RequestHandler = async (_req, res) => {
  ok(res, await service.listHospitals(env.TENANT_BASE_DOMAIN));
};

export const getHospital: RequestHandler = async (req, res) => {
  ok(res, await service.getHospital(req.params.id ?? "", env.TENANT_BASE_DOMAIN));
};

export const createHospital: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const input = req.body as service.CreateHospitalInput;
  ok(res, await service.createHospital(input, actor, context, env.TENANT_BASE_DOMAIN), 201);
};

export const setStatus: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const { status } = req.body as { status: TenantStatus };
  ok(
    res,
    await service.setHospitalStatus(
      req.params.id ?? "",
      status,
      actor,
      context,
      env.TENANT_BASE_DOMAIN,
    ),
  );
};

export const setPlan: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const { planCode } = req.body as { planCode: string };
  ok(res, await service.setHospitalPlan(req.params.id ?? "", planCode, actor, context));
};

export const setLimits: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const { maxBranches } = req.body as { maxBranches: number };
  ok(
    res,
    await service.setHospitalLimits(
      req.params.id ?? "",
      { maxBranches },
      actor,
      context,
      env.TENANT_BASE_DOMAIN,
    ),
  );
};

export const setLicense: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const body = req.body as {
    plan?: string;
    status?: "TRIAL" | "ACTIVE" | "EXPIRED" | "CANCELLED";
    expiresAt?: string;
    graceDays?: number;
    extendDays?: number;
    notes?: string;
  };
  const patch = {
    ...(body.plan != null ? { plan: body.plan } : {}),
    ...(body.status != null ? { status: body.status } : {}),
    ...(body.expiresAt != null ? { expiresAt: new Date(body.expiresAt) } : {}),
    ...(body.graceDays != null ? { graceDays: body.graceDays } : {}),
    ...(body.extendDays != null ? { extendDays: body.extendDays } : {}),
    ...(body.notes != null ? { notes: body.notes } : {}),
  };
  ok(
    res,
    await service.setHospitalLicense(
      req.params.id ?? "",
      patch,
      actor,
      context,
      env.TENANT_BASE_DOMAIN,
    ),
  );
};

export const setDomain: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const { customDomain } = req.body as { customDomain: string | null };
  ok(
    res,
    await service.setHospitalDomain(
      req.params.id ?? "",
      customDomain,
      actor,
      context,
      env.TENANT_BASE_DOMAIN,
    ),
  );
};

export const issueAdmin: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const input = req.body as { email: string; name?: string };
  ok(res, await service.issueHospitalAdmin(req.params.id ?? "", input, actor, context));
};

export const listEditions: RequestHandler = async (_req, res) => {
  ok(res, await service.editions());
};

/* ── operators ────────────────────────────────────────────────────────────── */

export const listOperators: RequestHandler = async (_req, res) => {
  ok(res, await service.listOperators());
};

export const createOperator: RequestHandler = async (req, res) => {
  const { actor, context } = actorOf(req);
  const input = req.body as { email: string; name: string; roles: PlatformRole[] };
  ok(res, await service.createOperator(input, actor, context), 201);
};

export const operatorAudit: RequestHandler = async (_req, res) => {
  ok(res, await service.operatorAudit(100));
};
