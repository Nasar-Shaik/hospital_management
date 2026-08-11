/**
 * Audit controller — HTTP only (Doc 09 §11).
 */
import type { RequestHandler } from "express";
import * as service from "./audit.service.js";
import type { AuditFilter } from "./audit.repository.js";
import { ok } from "../../core/http/respond.js";

export const listAudit: RequestHandler = async (req, res) => {
  const filter = req.query as unknown as AuditFilter;
  const { entries, total } = await service.listAudit(filter);

  ok(res, entries, 200, {
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
