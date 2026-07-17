/**
 * The reporting service — the composition root for the audit/register suite.
 *
 * ── WHY THE AGGREGATIONS ARE NOT HERE ───────────────────────────────────────
 * Each figure is summed by the module that OWNS the collection it comes from — the stock register
 * by `medicines`, visits and doctor load by `encounters`, diagnostics by `orders`, collections by
 * `billing` — because the Constitution says a collection is queried in exactly one place. This
 * module only COMPOSES those public reports and puts a human name where a report hands back a bare
 * id (a doctor, a technician). That is the one thing it adds: an auditor reads "Dr Rao: 42", not
 * "6a58…: 42".
 *
 * The report:view permission is tenant-scoped, so every report is a hospital-wide picture — which
 * is what an auditor asks for, and why the aggregations scope by tenant, not by branch.
 */
import { stockRegister, type StockRegisterRow } from "../medicines/index.js";
import { visitReport, doctorProductivity, type VisitReport } from "../encounters/index.js";
import { diagnosticsReport, type DiagnosticsReport } from "../orders/index.js";
import { collectionsReport, type CollectionsReport } from "../billing/index.js";
import { getById as getUser } from "../users/index.js";

export type { StockRegisterRow, VisitReport, DiagnosticsReport, CollectionsReport };

export interface DateRange {
  from: Date;
  to: Date;
}

/** Doctor load with the name resolved — what the productivity report actually shows. */
export interface DoctorLoadNamedRow {
  doctorId: string;
  doctorName: string;
  patients: number;
}

/** Diagnostics with each performer's name resolved. */
export interface DiagnosticsReportNamed extends Omit<DiagnosticsReport, "byPerformer"> {
  byPerformer: { performedBy: string; performerName: string; performed: number }[];
}

export const pharmacyStockRegister = (range: DateRange): Promise<StockRegisterRow[]> =>
  stockRegister(range.from, range.to);

export const patientVisits = (range: DateRange): Promise<VisitReport> =>
  visitReport(range.from, range.to);

export const collections = (range: DateRange): Promise<CollectionsReport> =>
  collectionsReport(range.from, range.to);

/**
 * Resolves a set of user ids to display names in one pass, tolerating the unknowns. A user who
 * was deleted (or an id that never was one) shows as a short, stable placeholder rather than
 * dropping the row — a report that silently omits work nobody can name is worse than one that
 * labels it plainly.
 */
async function resolveNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const entries = await Promise.all(
    unique.map(async (id) => {
      const user = await getUser(id).catch(() => undefined);
      return [id, user?.name ?? `Unknown (${id.slice(-6)})`] as const;
    }),
  );
  return new Map(entries);
}

export async function doctorLoad(range: DateRange): Promise<DoctorLoadNamedRow[]> {
  const rows = await doctorProductivity(range.from, range.to);
  const names = await resolveNames(rows.map((r) => r.doctorId));
  return rows.map((r) => ({
    doctorId: r.doctorId,
    doctorName: names.get(r.doctorId) ?? r.doctorId,
    patients: r.patients,
  }));
}

export async function diagnostics(range: DateRange): Promise<DiagnosticsReportNamed> {
  const report = await diagnosticsReport(range.from, range.to);
  const names = await resolveNames(report.byPerformer.map((p) => p.performedBy));
  return {
    ...report,
    byPerformer: report.byPerformer.map((p) => ({
      performedBy: p.performedBy,
      performerName: names.get(p.performedBy) ?? p.performedBy,
      performed: p.performed,
    })),
  };
}
