"use client";

/**
 * Reports — the audit/register suite (needs `report:view`).
 *
 * The screen an administrator or an auditor opens to answer month-wise, drug-wise, doctor-wise
 * questions: what stock moved, who visited, which doctor carried the load, how many tests ran and
 * by whom, and how much money actually came in. Every report takes the same period and every one
 * can be pulled as a CSV for the spreadsheet an audit lives in.
 *
 * The period is HALF-OPEN: the "To" date the user picks is a whole day, so the request's upper
 * bound is the start of the day after it — nothing that happens in that last day is lost.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiClientError,
  type CollectionsReport,
  type DiagnosticsReport,
  type DischargeRegister,
  type DoctorLoadRow,
  type DuesAgeingReport,
  type ReportRange,
  type RevenueLeakageReport,
  type StockRegisterRow,
  type VisitReport,
  type WalletRegister,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Button, Card } from "../../components/ui";
import { rupees } from "../../lib/money";

type Tab =
  | "stock"
  | "visits"
  | "doctors"
  | "diagnostics"
  | "collections"
  | "leakage"
  | "dues"
  | "advances"
  | "discharges";

const TABS: { id: Tab; label: string; slug: string }[] = [
  { id: "stock", label: "Pharmacy stock", slug: "pharmacy-stock" },
  { id: "visits", label: "Patient visits", slug: "patient-visits" },
  { id: "doctors", label: "Doctor load", slug: "doctor-load" },
  { id: "diagnostics", label: "Diagnostics", slug: "diagnostics" },
  { id: "collections", label: "Collections", slug: "collections" },
  { id: "leakage", label: "Revenue leakage", slug: "revenue-leakage" },
  { id: "dues", label: "Dues ageing", slug: "dues-ageing" },
  { id: "advances", label: "Advances", slug: "wallet" },
  { id: "discharges", label: "Discharges", slug: "discharge-outcomes" },
];

/** Human labels for the ageing buckets — the collections desk reads days, not raw keys. */
const DUES_BUCKET_LABEL: Record<string, string> = {
  "0-30": "0–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "Over 90 days",
};

/** The human name for each way a stay ends — what an auditor reads, not the wire value. */
const DISPOSITION_LABEL: Record<string, string> = {
  discharged: "Discharged (routine)",
  lama: "Left against advice (LAMA)",
  absconded: "Absconded",
  deceased: "Deceased",
};

const CLASS_LABEL: Record<string, string> = {
  OP: "Outpatient",
  IP: "Inpatient",
  ER: "Emergency",
  TELE: "Telemedicine",
  HOME: "Home",
};

function iso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
/** The day AFTER the chosen end date, at 00:00 — the half-open upper bound. */
function isoNextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ReportTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: (string | number)[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <tr>
            {headers.map((h, i) => (
              <th key={h} className={`px-4 py-3.5 font-medium ${i === 0 ? "" : "text-right"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={headers.length}
                className="px-4 py-8 text-center text-[var(--color-fg-muted)]"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r, ri) => (
              <tr key={ri} className="transition-colors hover:bg-[var(--color-bg-subtle)]">
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`px-4 py-3.5 ${ci === 0 ? "text-[var(--color-fg)]" : "text-right tabular-nums text-[var(--color-fg-muted)]"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-3">
      <div className="text-xs text-[var(--color-fg-muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold text-[var(--color-fg)]">{value}</div>
    </div>
  );
}

function ReportsPage() {
  const { api } = useAuth();

  // Deep-link support: `/reports?tab=dues` lands on that report (the dashboard links in this way).
  const params = useSearchParams();
  const requested = params.get("tab");
  const initialTab: Tab =
    requested && TABS.some((t) => t.id === requested) ? (requested as Tab) : "stock";

  const now = new Date();
  const [fromStr, setFromStr] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [toStr, setToStr] = useState(ymd(now));
  const [tab, setTab] = useState<Tab>(initialTab);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const [stock, setStock] = useState<StockRegisterRow[]>([]);
  const [visits, setVisits] = useState<VisitReport | null>(null);
  const [doctors, setDoctors] = useState<DoctorLoadRow[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [collections, setCollections] = useState<CollectionsReport | null>(null);
  const [leakage, setLeakage] = useState<RevenueLeakageReport | null>(null);
  const [dues, setDues] = useState<DuesAgeingReport | null>(null);
  const [advances, setAdvances] = useState<WalletRegister | null>(null);
  const [discharges, setDischarges] = useState<DischargeRegister | null>(null);

  const range: ReportRange = useMemo(
    () => ({ from: iso(fromStr), to: isoNextDay(toStr) }),
    [fromStr, toStr],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "stock") setStock(await api.reportPharmacyStock(range));
      else if (tab === "visits") setVisits(await api.reportPatientVisits(range));
      else if (tab === "doctors") setDoctors(await api.reportDoctorLoad(range));
      else if (tab === "diagnostics") setDiagnostics(await api.reportDiagnostics(range));
      else if (tab === "collections") setCollections(await api.reportCollections(range));
      else if (tab === "leakage") setLeakage(await api.reportRevenueLeakage(range));
      else if (tab === "dues") setDues(await api.reportDuesAgeing(range));
      else if (tab === "advances") setAdvances(await api.reportWallet(range));
      else if (tab === "discharges") setDischarges(await api.reportDischargeOutcomes(range));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not load the report.");
    } finally {
      setLoading(false);
    }
  }, [api, tab, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTab = TABS.find((t) => t.id === tab);
  const activeSlug = activeTab?.slug ?? "pharmacy-stock";
  const activeLabel = activeTab?.label ?? "report";

  // "1 Jul – 17 Jul 2026" — the human form of the selected window, shown beside the tabs.
  const periodLabel = useMemo(() => {
    const fmt = (s: string, withYear: boolean) =>
      new Date(`${s}T00:00:00`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(withYear ? { year: "numeric" } : {}),
      });
    if (!fromStr || !toStr) return "";
    const sameYear = fromStr.slice(0, 4) === toStr.slice(0, 4);
    return `${fmt(fromStr, !sameYear)} – ${fmt(toStr, true)}`;
  }, [fromStr, toStr]);

  async function downloadCsv() {
    setDownloading(true);
    try {
      const blob = await api.fetchReportCsv(activeSlug, range);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeSlug}-${fromStr}_to_${toStr}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not export the report.");
    } finally {
      setDownloading(false);
    }
  }

  function applyPreset(months: number) {
    const base = new Date();
    const start = new Date(base.getFullYear(), base.getMonth() - months, 1);
    const end = months === 0 ? base : new Date(base.getFullYear(), base.getMonth(), 0);
    setFromStr(ymd(start));
    setToStr(ymd(end));
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Reports</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Month-wise, drug-wise, doctor-wise — the registers an audit asks for. Pick a period, then
          a report; every one exports to CSV.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
            From
            <input
              type="date"
              value={fromStr}
              max={toStr}
              onChange={(e) => setFromStr(e.target.value)}
              className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            />
          </label>
          <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
            To
            <input
              type="date"
              value={toStr}
              min={fromStr}
              onChange={(e) => setToStr(e.target.value)}
              className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            />
          </label>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => applyPreset(0)}>
              This month
            </Button>
            <Button variant="ghost" onClick={() => applyPreset(1)}>
              Last month
            </Button>
          </div>
          <div className="ml-auto">
            <Button
              variant="secondary"
              onClick={() => void downloadCsv()}
              loading={downloading}
              title={`Export the ${activeLabel} report to CSV`}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                tab === t.id
                  ? "bg-[var(--color-brand-600)] font-medium text-[var(--color-on-accent)]"
                  : "border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Always show WHICH period the figures cover — a report with no visible date range is a
            number nobody can trust. */}
        <span className="text-xs text-[var(--color-fg-muted)]">{periodLabel}</span>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {loading ? (
        <Card>
          <p className="px-4 py-8 text-center text-[var(--color-fg-muted)]">Loading…</p>
        </Card>
      ) : (
        <>
          {tab === "stock" && (
            <Card>
              <ReportTable
                headers={["Medicine", "Opening", "Received", "Dispensed", "Adjusted", "Closing"]}
                rows={stock.map((r) => [
                  `${r.name} (${r.code})`,
                  r.opening,
                  r.received,
                  r.dispensed,
                  r.adjusted,
                  r.closing,
                ])}
                empty="No stock moved in this period."
              />
            </Card>
          )}

          {tab === "visits" && visits && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Total visits" value={String(visits.total)} />
                <Stat
                  label="Outpatient"
                  value={String(visits.byClass.find((c) => c.key === "OP")?.count ?? 0)}
                />
                <Stat
                  label="Inpatient"
                  value={String(visits.byClass.find((c) => c.key === "IP")?.count ?? 0)}
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By month
                  </h3>
                  <ReportTable
                    headers={["Month", "Visits"]}
                    rows={visits.byMonth.map((m) => [m.month, m.count])}
                    empty="No visits."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By care setting
                  </h3>
                  <ReportTable
                    headers={["Setting", "Visits"]}
                    rows={visits.byClass.map((c) => [CLASS_LABEL[c.key] ?? c.key, c.count])}
                    empty="No visits."
                  />
                </Card>
              </div>
            </div>
          )}

          {tab === "doctors" && (
            <Card>
              <ReportTable
                headers={["Doctor", "Patients seen"]}
                rows={doctors.map((d) => [d.doctorName, d.patients])}
                empty="No patients were seen by a doctor in this period."
              />
            </Card>
          )}

          {tab === "diagnostics" && diagnostics && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Tests ordered" value={String(diagnostics.total)} />
                <Stat label="Tests performed" value={String(diagnostics.performed)} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By category
                  </h3>
                  <ReportTable
                    headers={["Category", "Ordered", "Performed"]}
                    rows={diagnostics.byCategory.map((c) => [c.category, c.ordered, c.performed])}
                    empty="No tests."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By who performed them
                  </h3>
                  <ReportTable
                    headers={["Performed by", "Tests"]}
                    rows={diagnostics.byPerformer.map((p) => [p.performerName, p.performed])}
                    empty="No tests were performed yet."
                  />
                </Card>
              </div>
            </div>
          )}

          {tab === "discharges" && discharges && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Stays ended" value={String(discharges.total)} />
                <Stat
                  label="Deaths"
                  value={String(
                    discharges.byDisposition.find((d) => d.key === "deceased")?.count ?? 0,
                  )}
                />
                <Stat
                  label="LAMA"
                  value={String(discharges.byDisposition.find((d) => d.key === "lama")?.count ?? 0)}
                />
                <Stat
                  label="Absconded"
                  value={String(
                    discharges.byDisposition.find((d) => d.key === "absconded")?.count ?? 0,
                  )}
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By outcome
                  </h3>
                  <ReportTable
                    headers={["Outcome", "Stays"]}
                    rows={discharges.byDisposition.map((d) => [
                      DISPOSITION_LABEL[d.key] ?? d.key,
                      d.count,
                    ])}
                    empty="No inpatient stays ended in this period."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By month
                  </h3>
                  <ReportTable
                    headers={["Month", "Stays ended"]}
                    rows={discharges.byMonth.map((m) => [m.month, m.count])}
                    empty="No inpatient stays ended in this period."
                  />
                </Card>
              </div>
            </div>
          )}

          {tab === "advances" && advances && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Advances collected" value={rupees(advances.deposits.total)} />
                <Stat label="Utilised against bills" value={rupees(advances.utilized.total)} />
                <Stat label="Refunded" value={rupees(advances.refunds.total)} />
                <Stat label="Currently held" value={rupees(advances.outstandingHeld)} />
              </div>
              {/* The advance register is a liability story: money the hospital holds on patients'
                  behalf. "Utilised" is a transfer to revenue, not new income; "currently held" is a
                  point-in-time balance, not a period total. */}
              <p className="text-xs text-[var(--color-fg-muted)]">
                Admission advances the hospital holds on patients’ behalf. “Utilised against bills”
                is that money moving to revenue as care is billed — a transfer, already counted when
                it was deposited. “Currently held” is the balance owed to patients right now, not a
                total for the period.
              </p>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    Advances collected by method
                  </h3>
                  <ReportTable
                    headers={["Method", "Collected", "Deposits"]}
                    rows={advances.deposits.byMethod.map((m) => [
                      m.method,
                      rupees(m.amount),
                      m.count,
                    ])}
                    empty="No advances collected in this period."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    Refunds by method
                  </h3>
                  <ReportTable
                    headers={["Method", "Refunded", "Refunds"]}
                    rows={advances.refunds.byMethod.map((m) => [
                      m.method,
                      rupees(m.amount),
                      m.count,
                    ])}
                    empty="No refunds in this period."
                  />
                </Card>
              </div>
            </div>
          )}

          {tab === "collections" && collections && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Collected at counter" value={rupees(collections.total)} />
                <Stat label="Payments taken" value={String(collections.count)} />
                <Stat label="Settled from advance" value={rupees(collections.settledFromAdvance)} />
              </div>
              {/* Say plainly what "collected" does and does not include — the one sentence that keeps
                  an auditor from adding the advance figure twice. */}
              <p className="text-xs text-[var(--color-fg-muted)]">
                “Collected at counter” is direct payment (cash, card, UPI). “Settled from advance”
                was collected earlier as an admission advance and is shown here only for context —
                it is counted in the Advances report, not added to the counter total.
              </p>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By month
                  </h3>
                  <ReportTable
                    headers={["Month", "Received", "Payments"]}
                    rows={collections.byMonth.map((m) => [m.month, rupees(m.amount), m.count])}
                    empty="No money received in this period."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By payment method
                  </h3>
                  <ReportTable
                    headers={["Method", "Received", "Payments"]}
                    rows={collections.byMethod.map((m) => [m.method, rupees(m.amount), m.count])}
                    empty="No payments."
                  />
                </Card>
              </div>
              {/* The drawer, per person. The reason this table exists: a desk run by several
                  people across a shift cannot be counted from one hospital-wide total. */}
              <Card>
                <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                  Taken by
                </h3>
                <ReportTable
                  headers={["Staff member", "Received", "Payments"]}
                  rows={collections.byCollector.map((c) => [
                    c.collectorName,
                    rupees(c.amount),
                    c.count,
                  ])}
                  empty="No payments."
                />
                <p className="px-4 pt-1 pb-3 text-xs text-[var(--color-fg-muted)]">
                  Direct counter payments only, so these rows add up to “Collected at counter”. “Not
                  recorded” is money posted without a signed-in collector.
                </p>
              </Card>
            </div>
          )}

          {tab === "leakage" && leakage && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Unbilled (revenue at risk)" value={rupees(leakage.total)} />
                <Stat label="Unbilled charges" value={String(leakage.count)} />
              </div>
              <p className="text-xs text-[var(--color-fg-muted)]">
                Care that was given and priced but never put on a bill — a charge posted in this
                period, worth more than ₹0, not voided, and still on no invoice. Finalize these
                visits&apos; bills to recover the money.
              </p>
              <Card>
                <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                  Visits to bill
                </h3>
                <ReportTable
                  headers={["UHID", "Patient", "Unbilled", "Charges"]}
                  rows={leakage.byEncounter.map((r) => [
                    r.uhid,
                    r.patientName,
                    rupees(r.amount),
                    r.count,
                  ])}
                  empty="Nothing unbilled in this period — every charge is on a bill."
                />
              </Card>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By category
                  </h3>
                  <ReportTable
                    headers={["Category", "Unbilled", "Charges"]}
                    rows={leakage.byCategory.map((c) => [c.category, rupees(c.amount), c.count])}
                    empty="Nothing unbilled."
                  />
                </Card>
                <Card>
                  <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                    By source
                  </h3>
                  <ReportTable
                    headers={["Source", "Unbilled", "Charges"]}
                    rows={leakage.bySource.map((s) => [s.source, rupees(s.amount), s.count])}
                    empty="Nothing unbilled."
                  />
                </Card>
              </div>
            </div>
          )}

          {tab === "dues" && dues && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Outstanding (billed, unpaid)" value={rupees(dues.totalOutstanding)} />
                <Stat label="Bills with a balance" value={String(dues.invoiceCount)} />
              </div>
              <p className="text-xs text-[var(--color-fg-muted)]">
                Finalized bills not yet fully paid, as of{" "}
                {periodLabel.split(" – ")[1] || "the To date"}, aged by when the bill was raised.
                The older a debt, the harder it is to collect — work the oldest buckets first.
              </p>
              <Card>
                <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                  By age
                </h3>
                <ReportTable
                  headers={["Age", "Outstanding", "Bills"]}
                  rows={dues.buckets.map((b) => [
                    DUES_BUCKET_LABEL[b.bucket] ?? b.bucket,
                    rupees(b.amount),
                    b.count,
                  ])}
                  empty="Nothing outstanding."
                />
              </Card>
              <Card>
                <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
                  Who owes (heaviest first)
                </h3>
                <ReportTable
                  headers={["Bill", "UHID", "Patient", "Outstanding", "Age (days)"]}
                  rows={dues.topDebtors.map((r) => [
                    r.number ?? "—",
                    r.uhid,
                    r.patientName,
                    rupees(r.outstanding),
                    r.ageDays,
                  ])}
                  empty="No outstanding bills — everything billed has been paid."
                />
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  // `useSearchParams` (the ?tab= deep-link) must sit under a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ReportsPage />
    </Suspense>
  );
}
