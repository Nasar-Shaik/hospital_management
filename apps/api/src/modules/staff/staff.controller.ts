/**
 * Staff controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import * as staff from "./staff.service.js";
import type { ListUsersQuery } from "./staff.schema.js";

function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(status).json(body);
}

export const createStaff: RequestHandler = async (req, res) => {
  const input = req.body as staff.CreateStaffInput;
  ok(res, await staff.createStaff(input), 201);
};

export const listStaff: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListUsersQuery;
  const { users, total } = await staff.listStaff(query);

  ok(res, users, 200, {
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
  });
};

export const getStaff: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await staff.getStaff(id));
};

export const updateStaff: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await staff.updateStaff(id, req.body as { name?: string }));
};

export const setStaffStatus: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { status } = req.body as { status: "active" | "disabled" };
  ok(res, await staff.setStaffStatus(id, status));
};

export const resetStaffPassword: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  const { password } = req.body as { password?: string };
  ok(res, await staff.resetStaffPassword(id, password));
};
