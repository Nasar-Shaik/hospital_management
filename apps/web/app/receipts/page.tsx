"use client";

/**
 * Receipts register — every payment the hospital took in a period, for cross-checking one later.
 *
 * It merges the two ways money arrives: BILL payments (the OP fee, tests, pharmacy) and ADVANCE
 * deposits (an OP or admission advance). Each row carries the id to reprint the exact receipt, so an
 * auditor who is handed a printed slip can find it here, confirm it, and print it again. Search is
 * client-side over the loaded period — by patient, UHID or receipt number.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ReceiptRow, type ReportRange } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Card, DataTable, ErrorAlert, type Column } from "../../components/ui";
import { rupees } from "../../lib/money";
import { useBranch } from "../../components/BranchProvider";
import { dayRangeInZone, todayInZone } from "../../lib/day";

function fmtDateTime(isoStr: string): string {
  return new Date(isoStr).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Receipts() {
  const { api, can } = useAuth();
  // The day's takings are the DESK's day — the same one the server reckons collections in.
  const { timezone } = useBranch();
  const today = todayInZone(timezone);

  const [fromStr, setFromStr] = useState(today);
  const [toStr, setToStr] = useState(today);
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const range: ReportRange = useMemo(
    () => dayRangeInZone(fromStr, toStr, timezone),
    [fromStr, toStr, timezone],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.reportReceipts(range));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.patientName.toLowerCase().includes(needle) ||
        r.uhid.toLowerCase().includes(needle) ||
        r.receiptNo.toLowerCase().includes(needle),
    );
  }, [rows, q]);

  const total = filtered.reduce((sum, r) => sum + r.amount, 0);

  const hrefOf = (r: ReceiptRow): string =>
    r.kind === "advance" ? `/receipt/advance/${r.refId}` : `/receipt/${r.refId}`;

  const columns: Column<ReceiptRow>[] = [
    {
      key: "receiptNo",
      header: "Receipt no",
      cellClassName: "font-mono text-xs font-medium text-[var(--color-fg)]",
      render: (r) => r.receiptNo,
    },
    {
      key: "type",
      header: "Type",
      render: (r) => (
        <Badge tone={r.kind === "advance" ? "brand" : "neutral"}>
          {r.kind === "advance" ? "Advance" : "Bill"}
        </Badge>
      ),
    },
    {
      key: "patient",
      header: "Patient",
      render: (r) => (
        <>
          <span className="text-[var(--color-fg)]">{r.patientName}</span>{" "}
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{r.uhid}</span>
        </>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cellClassName: "font-medium text-[var(--color-fg)] tabular-nums",
      render: (r) => rupees(r.amount),
    },
    {
      key: "when",
      header: "When",
      cellClassName: "whitespace-nowrap text-[var(--color-fg-muted)]",
      render: (r) => fmtDateTime(r.at),
    },
    {
      key: "action",
      header: "",
      align: "right",
      render: (r) => (
        <a href={hrefOf(r)} className="text-[var(--color-brand-700)] hover:underline">
          Receipt →
        </a>
      ),
    },
  ];

  if (!can("billing:read")) {
    return (
      <Card className="p-8 text-center text-sm text-[var(--color-fg-muted)]">
        You do not have permission to view the receipts register.
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Receipts</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Every payment taken — bills and advances. Search by patient or receipt number, and reprint
          any receipt for verification.
        </p>
      </div>

      {error != null && (
        <ErrorAlert error={error} fallback="Could not load the receipts register." />
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
              From
            </span>
            <input
              type="date"
              value={fromStr}
              max={toStr}
              onChange={(e) => setFromStr(e.target.value)}
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">To</span>
            <input
              type="date"
              value={toStr}
              min={fromStr}
              max={today}
              onChange={(e) => setToStr(e.target.value)}
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
          </label>
          <label className="ml-auto block flex-1 sm:max-w-xs">
            <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
              Search
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Patient, UHID or receipt no…"
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
            />
          </label>
        </div>
      </Card>

      <div className="flex items-center justify-between px-1 text-sm">
        <span className="font-semibold text-[var(--color-fg)]">
          {filtered.length} {filtered.length === 1 ? "receipt" : "receipts"}
        </span>
        <span className="text-[var(--color-fg-muted)]">
          Total{" "}
          <span className="font-semibold text-[var(--color-fg)] tabular-nums">{rupees(total)}</span>
        </span>
      </div>

      <DataTable<ReceiptRow>
        columns={columns}
        rows={filtered}
        keyOf={(r) => `${r.kind}-${r.refId}`}
        loading={loading}
        empty="No receipts in this period."
      />
    </div>
  );
}

export default function ReceiptsPage() {
  return <Receipts />;
}
