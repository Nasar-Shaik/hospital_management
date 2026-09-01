/**
 * General store controller — HTTP only (Doc 09 §11).
 *
 * No branch is threaded through any of these writes: the site comes from the request context in
 * the service, through `writeBranchId()` (ADR-0015). Nothing here parses a date, because nothing
 * in this module takes one — a store has no expiry, deliberately (see `inventory.model.ts`).
 */
import type { RequestHandler } from "express";
import * as store from "./inventory.service.js";
import { ok } from "../../core/http/respond.js";
import type {
  AdjustBody,
  CreateItemBody,
  CreateSupplierBody,
  IssueBody,
  ReceiveBody,
  StoreQuery,
  SupplierQuery,
  UpdateItemBody,
  UpdateSupplierBody,
} from "./inventory.schema.js";

export const listItems: RequestHandler = async (req, res) => {
  const q = req.query as unknown as StoreQuery;
  ok(
    res,
    await store.listStore({
      ...(q.search ? { search: q.search } : {}),
      ...(q.lowStockOnly === "true" ? { lowStockOnly: true } : {}),
      ...(q.includeInactive === "true" ? { includeInactive: true } : {}),
    }),
  );
};

export const createItem: RequestHandler = async (req, res) => {
  ok(res, await store.createItem(req.body as CreateItemBody), 201);
};

export const updateItem: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.updateItem(id, req.body as UpdateItemBody));
};

export const movements: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.listMovements(id));
};

export const receive: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.receive(id, req.body as ReceiveBody), 201);
};

export const issue: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.issue(id, req.body as IssueBody), 201);
};

export const adjust: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.adjust(id, req.body as AdjustBody), 201);
};

export const destinations: RequestHandler = async (_req, res) => {
  ok(res, await store.listDestinations());
};

export const listSuppliers: RequestHandler = async (req, res) => {
  const q = req.query as unknown as SupplierQuery;
  ok(
    res,
    await store.listSuppliers({
      ...(q.search ? { search: q.search } : {}),
      ...(q.includeInactive === "true" ? { includeInactive: true } : {}),
    }),
  );
};

export const createSupplier: RequestHandler = async (req, res) => {
  ok(res, await store.createSupplier(req.body as CreateSupplierBody), 201);
};

export const updateSupplier: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  ok(res, await store.updateSupplier(id, req.body as UpdateSupplierBody));
};
