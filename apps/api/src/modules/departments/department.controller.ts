/**
 * Department controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as departments from "./department.service.js";
import type { CreateDepartmentBody, UpdateDepartmentBody } from "./department.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const list: RequestHandler = async (_req, res) => {
  ok(res, await departments.listDepartments());
};

export const create: RequestHandler = async (req, res) => {
  ok(res, await departments.createDepartment(req.body as CreateDepartmentBody), 201);
};

export const update: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await departments.updateDepartment(id, req.body as UpdateDepartmentBody));
};
