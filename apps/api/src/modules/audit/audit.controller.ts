/**
 * Audit controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import * as service from "./audit.service.js";
import type { AuditFilter } from "./audit.repository.js";

function ok<T>(res: Response, data: T, meta?: ApiEnvelope<T>["meta"]): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  res.status(200).json(body);
}

export const listAudit: RequestHandler = async (req, res) => {
  const filter = req.query as unknown as AuditFilter;
  const { entries, total } = await service.listAudit(filter);

  ok(res, entries, {
    page: filter.page,
    limit: filter.limit,
    total,
    hasMore: filter.page * filter.limit < total,
  });
};

export const exportAudit: RequestHandler = async (req, res) => {
  const filter = req.query as unknown as Omit<AuditFilter, "page" | "limit">;
  const { csv, rows, truncated } = await service.exportTrail(filter);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="audit-${stamp}.csv"`);
  // Tells an operator the file is partial WITHOUT changing the CSV body, which a
  // spreadsheet would otherwise render as a data row.
  res.setHeader("x-audit-rows", String(rows));
  res.setHeader("x-audit-truncated", String(truncated));
  res.status(200).send(csv);
};

export const checkIntegrity: RequestHandler = async (_req, res) => {
  ok(res, await service.checkIntegrity());
};
