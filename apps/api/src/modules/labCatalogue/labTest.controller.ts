/**
 * Lab test catalogue controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import { AppError } from "../../core/errors/appError.js";
import * as catalogue from "./labTest.service.js";
import type { CreateLabTestBody, UpdateLabTestBody, ListLabTestsQuery } from "./labTest.schema.js";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

export const listTests: RequestHandler = async (req, res) => {
  const { includeInactive } = req.query as ListLabTestsQuery;
  ok(res, await catalogue.listTests(Boolean(includeInactive)));
};

export const getTestByCode: RequestHandler = async (req, res) => {
  const { code } = req.params as { code: string };
  const test = await catalogue.getTestByCode(code);
  if (!test) throw new AppError("HMS-GEN-404", 404, "Lab test not found", { code });
  ok(res, test);
};

export const createTest: RequestHandler = async (req, res) => {
  ok(res, await catalogue.createTest(req.body as CreateLabTestBody), 201);
};

export const updateTest: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await catalogue.updateTest(id, req.body as UpdateLabTestBody));
};
