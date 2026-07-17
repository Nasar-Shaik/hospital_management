/**
 * RBAC controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import * as rbac from "./rbac.service.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const listPermissions: RequestHandler = async (_req, res) => {
  ok(res, await rbac.listPermissions());
};

export const listRoles: RequestHandler = async (_req, res) => {
  ok(res, await rbac.listRoles());
};

export const getRole: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const role = await rbac.getRoleById(id);
  if (!role) throw new AppError("HMS-GEN-404", 404, "Role not found", { roleId: id });
  ok(res, { ...role, permissions: await rbac.getRolePermissions(id) });
};

export const createRole: RequestHandler = async (req, res) => {
  const input = req.body as rbac.CreateRoleInput;
  ok(res, await rbac.createRole(input), 201);
};

export const setRolePermissions: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { permissions } = req.body as { permissions: string[] };
  await rbac.setRolePermissions(id, permissions);
  ok(res, { roleId: id, permissions });
};

export const deleteRole: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await rbac.deleteRole(id);
  ok(res, { deleted: true });
};

export const assignRole: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { roleCode, branchIds } = req.body as { roleCode: string; branchIds: string[] };
  await rbac.assignRoleByCode(id, roleCode, branchIds);
  ok(res, await rbac.getAuthorizationProfile(id));
};

export const revokeRole: RequestHandler = async (req, res) => {
  const { id, roleCode } = req.params as { id: string; roleCode: string };
  await rbac.revokeRoleByCode(id, roleCode);
  ok(res, await rbac.getAuthorizationProfile(id));
};
