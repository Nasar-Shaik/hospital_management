/**
 * Reporting controller — HTTP only (Doc 09 §11).
 *
 * Every report answers in one of two shapes on the same data: JSON for the screen, or CSV for the
 * spreadsheet an auditor lives in (`?format=csv`). The CSV of a multi-section report is its
 * PRINCIPAL table — the drug-wise register, the month-wise collections — because a spreadsheet is
 * one grid, and the breakdowns a screen shows around it are still one query away.
 */
import type { RequestHandler, Response } from "express";
import type { ApiEnvelope } from "@medicore/types";
import { requireAuth } from "../../middleware/authenticate.js";
import * as reporting from "./reporting.service.js";
import type { ReportRangeQuery } from "./reporting.schema.js";

function ok<T>(res: Response, data: T): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(200).json(body);
}

function rangeOf(req: { query: unknown }): { range: reporting.DateRange; csv: boolean } {
  const q = req.query as ReportRangeQuery;
  return { range: { from: q.from, to: q.to }, csv: q.format === "csv" };
}

/** RFC 4180-ish: quote a field and double any inner quotes. Numbers and plain text pass clean. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(
  res: Response,
  name: string,
  headers: string[],
  rows: (string | number)[][],
): void {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${name}-${stamp}.csv"`);
  res.status(200).send(lines.join("\n"));
}

/** Paise → rupees, two decimals, for a spreadsheet cell. */
const rupees = (paise: number): string => (paise / 100).toFixed(2);

/**
 * A clinician's OWN activity for a period. Self-scoped to the caller — no `report:view`, because
 * you can always see what you did. JSON only (it is a dashboard panel, not a spreadsheet export).
 */
export const myActivity: RequestHandler = async (req, res) => {
  const { range } = rangeOf(req);
  ok(res, await reporting.myActivity(requireAuth(req).userId, range));
};

export const stockRegister: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const rows = await reporting.pharmacyStockRegister(range);
  if (csv) {
    sendCsv(
      res,
      "stock-register",
      ["Code", "Medicine", "Opening", "Received", "Dispensed", "Adjusted", "Closing"],
      rows.map((r) => [r.code, r.name, r.opening, r.received, r.dispensed, r.adjusted, r.closing]),
    );
    return;
  }
  ok(res, rows);
};

export const patientVisits: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const report = await reporting.patientVisits(range);
  if (csv) {
    sendCsv(
      res,
      "patient-visits",
      ["Month", "Visits"],
      report.byMonth.map((m) => [m.month, m.count]),
    );
    return;
  }
  ok(res, report);
};

export const doctorLoad: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const rows = await reporting.doctorLoad(range);
  if (csv) {
    sendCsv(
      res,
      "doctor-load",
      ["Doctor", "Patients"],
      rows.map((r) => [r.doctorName, r.patients]),
    );
    return;
  }
  ok(res, rows);
};

export const diagnostics: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const report = await reporting.diagnostics(range);
  if (csv) {
    sendCsv(
      res,
      "diagnostics",
      ["Performed by", "Tests performed"],
      report.byPerformer.map((p) => [p.performerName, p.performed]),
    );
    return;
  }
  ok(res, report);
};

export const collections: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const report = await reporting.collections(range);
  if (csv) {
    sendCsv(
      res,
      "collections",
      ["Month", "Amount (INR)", "Payments"],
      report.byMonth.map((m) => [m.month, rupees(m.amount), m.count]),
    );
    return;
  }
  ok(res, report);
};

export const dischargeOutcomes: RequestHandler = async (req, res) => {
  const { range, csv } = rangeOf(req);
  const report = await reporting.dischargeOutcomes(range);
  if (csv) {
    // The principal table is the outcome breakdown — the one line an auditor reads for the
    // mortality and LAMA counts. The month-wise census is a screen breakdown, one query away.
    sendCsv(
      res,
      "discharge-outcomes",
      ["Outcome", "Count"],
      report.byDisposition.map((d) => [d.key, d.count]),
    );
    return;
  }
  ok(res, report);
};
