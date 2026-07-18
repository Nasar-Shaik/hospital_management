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
import {
  visitReport,
  doctorProductivity,
  dischargeRegister,
  type VisitReport,
  type DischargeRegister,
} from "../encounters/index.js";
import { diagnosticsReport, type DiagnosticsReport } from "../orders/index.js";
import { collectionsReport, type CollectionsReport } from "../billing/index.js";
import { walletReport, type WalletRegister } from "../wallet/index.js";
import { getById as getUser } from "../users/index.js";
import { encountersByDoctor } from "../encounters/index.js";
import { ordersByUser } from "../orders/index.js";
import { prescriptionsByUser } from "../prescriptions/index.js";
import { namesByIds } from "../patients/index.js";

export type {
  StockRegisterRow,
  VisitReport,
  DiagnosticsReport,
  CollectionsReport,
  DischargeRegister,
  WalletRegister,
};

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
 * The advance register — admission advances collected, refunded, utilised against bills, and the
 * balance the hospital currently holds. The counterpart to `collections`: money that came in as an
 * advance and how it was drawn down, kept apart from direct counter collections so neither figure
 * double-counts the other.
 */
export const walletRegister = (range: DateRange): Promise<WalletRegister> =>
  walletReport({ from: range.from, to: range.to });

/** How inpatient stays ended in the period — routine discharges, LAMA, absconded, deaths. */
export const dischargeOutcomes = (range: DateRange): Promise<DischargeRegister> =>
  dischargeRegister(range.from, range.to);

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

/* ── "My day" — a clinician's OWN activity ──────────────────────────────────────
 * Not a hospital-wide register but a personal one: "what did I do in this period?".
 * Composed the same way — each figure summed by the module that owns the collection — but keyed
 * on the CALLER's id, so it needs no `report:view`; you can always see your own work. Patient
 * ids are resolved to a name/UHID here (one batch) so each drill-down row links to a real chart. */

/** A patient as an activity row shows them — enough to recognise and to link to the profile. */
export interface ActivityPatientRef {
  id: string;
  uhid: string;
  name: string;
}

export interface MyActivity {
  /** Distinct patients seen (encounters), not visit count — a returning patient is one person. */
  patientsSeen: number;
  visits: {
    patient: ActivityPatientRef;
    encounterId: string;
    at: string;
    class: string;
    status: string;
  }[];
  tests: {
    patient: ActivityPatientRef;
    orderId: string;
    name: string;
    category: string;
    status: string;
    at: string;
  }[];
  prescriptions: {
    patient: ActivityPatientRef;
    prescriptionId: string;
    drugs: string[];
    at: string;
  }[];
}

export async function myActivity(userId: string, range: DateRange): Promise<MyActivity> {
  const [encs, ords, rxs] = await Promise.all([
    encountersByDoctor(userId, range.from, range.to),
    ordersByUser(userId, range.from, range.to),
    prescriptionsByUser(userId, range.from, range.to),
  ]);

  const patientIds = [
    ...new Set([
      ...encs.map((e) => e.patientId),
      ...ords.map((o) => o.patientId),
      ...rxs.map((r) => r.patientId),
    ]),
  ];
  const names = new Map((await namesByIds(patientIds)).map((n) => [n.id, n]));
  const ref = (id: string): ActivityPatientRef =>
    names.get(id) ?? { id, uhid: "—", name: "Unknown patient" };

  return {
    patientsSeen: new Set(encs.map((e) => e.patientId)).size,
    visits: encs.map((e) => ({
      patient: ref(e.patientId),
      encounterId: e.id,
      at: e.arrivedAt.toISOString(),
      class: e.class,
      status: e.status,
    })),
    tests: ords.map((o) => ({
      patient: ref(o.patientId),
      orderId: o.id,
      name: o.name,
      category: o.category,
      status: o.status,
      at: o.orderedAt.toISOString(),
    })),
    prescriptions: rxs.map((r) => ({
      patient: ref(r.patientId),
      prescriptionId: r.id,
      drugs: r.lines.map((l) => l.drugName),
      at: (r.signedAt ?? r.prescribedAt).toISOString(),
    })),
  };
}
