/**
 * Department controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as departments from "./department.service.js";
import type { CreateDepartmentBody, UpdateDepartmentBody } from "./department.schema.js";
import { ok } from "../../core/http/respond.js";

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
