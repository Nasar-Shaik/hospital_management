"use client";

/**
 * Activity trail (Doc 02 A5, Doc 09 §9).
 *
 * The screen a compliance officer, a security investigator, or a hospital
 * administrator opens after something has gone wrong — which means it has to
 * answer "who did this, when, from where" without them learning a query language.
 *
 * Three design choices worth defending:
 *
 *  1. FAILURES ARE AS PROMINENT AS SUCCESSES. A denied permission and a failed
 *     login are the events that reveal an attack in progress, and a trail that
 *     visually buries them is a trail that gets read too late.
 *
 *  2. THE CHANGED FIELDS ARE SHOWN INLINE, not behind a click. "What actually
 *     changed" is the question; making someone expand a row to find out means
 *     scanning fifty rows takes fifty clicks.
 *
 *  3. INTEGRITY IS ON THE PAGE, not in a report we send them. The customer can
 *     verify the chain themselves, whenever they like.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClientError, type AuditEntry, type AuditIntegrity } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import { todayInZone } from "../../lib/day";
import { Alert, Badge, Button, DataTable, PermissionGate, type Column } from "../../components/ui";

const CATEGORIES = [
  { value: "", label: "All activity" },
  { value: "security", label: "Security" },
  { value: "admin", label: "Administration" },
  { value: "phi", label: "Patient data" },
  { value: "financial", label: "Financial" },
  { value: "access", label: "Record access" },
] as const;

function categoryTone(category: AuditEntry["category"]): "neutral" | "brand" | "danger" {
  if (category === "phi" || category === "financial") return "brand";
  if (category === "security") return "danger";
  return "neutral";
}

/** `user.created` → "User created". The trail is read by people, not by grep. */
function humanize(action: string): string {
  const words = action
    .split(".")
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function changedFields(entry: AuditEntry): string {
  const fields = entry.meta?.fields;
  if (Array.isArray(fields) && fields.length > 0) return fields.join(", ");
  return "—";
}

function AuditTrail() {
  const { api, can } = useAuth();
  const { timezone } = useBranch();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<AuditIntegrity | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * Every narrowing the reader has chosen, in one object — shared by the list and the CSV export
   * so the file always matches the screen. Dates become an inclusive day: `to` is pushed to the
   * end of the chosen day so "the 3rd" means all of the 3rd, not midnight at its start.
   */
  const filters = useMemo(
    () => ({
      ...(category ? { category: category as AuditEntry["category"] } : {}),
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
      ...(failuresOnly ? { outcome: "failure" as const } : {}),
    }),
    [category, from, to, failuresOnly],
  );

  const hasFilters = category !== "" || from !== "" || to !== "" || failuresOnly;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listAudit({ page, limit: 25, ...filters });
      setEntries(result.items);
      setTotal(result.meta.total ?? result.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the activity trail.");
    } finally {
      setLoading(false);
    }
  }, [api, filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const [exporting, setExporting] = useState(false);

  async function verify() {
    setChecking(true);
    try {
      setIntegrity(await api.auditIntegrity());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Integrity check failed to run.");
    } finally {
      setChecking(false);
    }
  }

  /**
   * ── WHY THIS IS A BUTTON AND NOT A LINK ─────────────────────────────────────
   * It was `<a href={api.auditExportUrl(filters)}>`, which cannot work: `/audit/export` is behind
   * `authenticate()`, which reads `Authorization: Bearer` and nothing else, and a plain
   * navigation carries no such header. The link produced a 401 page — and it LOOKED right in
   * review, because a URL builder cannot fail; only the far end can.
   *
   * Fetching it authenticated also recovers something the file cannot say about itself: the
   * export is capped, and a truncated CSV is byte-indistinguishable from a complete one. Handing
   * an auditor a trail that silently stops is the failure worth spending a button on.
   */
  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const { blob, rows, truncated } = await api.fetchAuditCsv(filters);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Named for the hospital's day, so a file exported at 01:00 IST is not stamped yesterday.
      a.download = `audit-${todayInZone(timezone)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (truncated) {
        setError(
          `Exported ${String(rows ?? 0)} entries — the trail was longer than one export allows. ` +
            `Narrow the dates and export again; this file is not complete.`,
        );
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not export the trail.");
    } finally {
      setExporting(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / 25));

  const columns: Column<AuditEntry>[] = [
    {
      key: "when",
      header: "When",
      cellClassName: "whitespace-nowrap text-[var(--color-fg-muted)]",
      render: (e) => new Date(e.at).toLocaleString(),
    },
    {
      key: "who",
      header: "Who",
      render: (e) => (
        <>
          <span className="block text-[var(--color-fg)]">
            {e.actorEmail ?? e.actorId ?? "System"}
          </span>
          {e.actorRoles?.[0] && (
            <span className="text-xs text-[var(--color-fg-subtle)]">{e.actorRoles[0]}</span>
          )}
        </>
      ),
    },
    {
      key: "what",
      header: "What",
      render: (e) => (
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-fg)]">{humanize(e.action)}</span>
          <Badge tone={categoryTone(e.category)}>{e.category}</Badge>
          {e.outcome === "failure" && <Badge tone="danger">refused</Badge>}
        </div>
      ),
    },
    {
      key: "changed",
      header: "Changed",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (e) => changedFields(e),
    },
    {
      key: "from",
      header: "From",
      cellClassName: "font-mono text-xs text-[var(--color-fg-subtle)]",
      render: (e) => e.ip ?? "—",
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Activity trail</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Every change to an account, a role, a plan or a patient record — recorded permanently
            and in order. Entries can never be edited or deleted, including by us.
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void verify()} disabled={checking}>
            {checking ? "Checking…" : "Check integrity"}
          </Button>

          <PermissionGate can={can} permission="audit:export">
            <Button variant="secondary" onClick={() => void exportCsv()} disabled={exporting}>
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </PermissionGate>
        </div>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}

      {integrity && (
        <Alert tone={integrity.ok ? "success" : "danger"}>
          {integrity.ok ? (
            <>
              <strong>Trail verified.</strong> {integrity.entriesVerified} entries across{" "}
              {integrity.anchors} sealed {integrity.anchors === 1 ? "block" : "blocks"} match their
              recorded fingerprints. Nothing has been altered since it was written.
              {integrity.anchors === 0 && (
                <span className="block text-xs opacity-80">
                  No blocks are sealed yet — sealing runs nightly, so entries from the last few
                  minutes are not covered by a fingerprint.
                </span>
              )}
            </>
          ) : (
            <>
              <strong>This trail does not verify.</strong> {integrity.problems.length} problem
              {integrity.problems.length === 1 ? "" : "s"} found — the record has been altered since
              it was sealed. Contact support immediately.
              <ul className="mt-2 list-disc pl-5 text-xs">
                {integrity.problems.slice(0, 5).map((p, i) => (
                  <li key={i}>{p.detail}</li>
                ))}
              </ul>
            </>
          )}
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((option) => (
          <button
            key={option.value}
            onClick={() => {
              setCategory(option.value);
              setPage(1);
            }}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              category === option.value
                ? "bg-[var(--color-brand-600)] font-medium text-[var(--color-on-accent)]"
                : "border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Narrow the trail — the point is to read a specific window or the refusals alone, not to
          scroll a whole hospital's day. Every control resets to the first page. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <label className="flex flex-col text-xs text-[var(--color-fg-muted)]">
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="mt-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setFailuresOnly((v) => !v);
            setPage(1);
          }}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
            failuresOnly
              ? "bg-[var(--color-danger)] font-medium text-[var(--color-on-accent)]"
              : "border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
          }`}
        >
          Refusals only
        </button>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setCategory("");
              setFrom("");
              setTo("");
              setFailuresOnly(false);
              setPage(1);
            }}
            className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-fg-muted)] underline hover:text-[var(--color-fg)]"
          >
            Clear filters
          </button>
        )}
      </div>

      <DataTable<AuditEntry>
        columns={columns}
        rows={loading ? [] : entries}
        keyOf={(e) => e.id}
        loading={loading}
        empty="Nothing recorded yet in this category."
        rowClassName={(e) => (e.outcome === "failure" ? "bg-[var(--color-danger-bg)]/30" : "")}
      />

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-[var(--color-fg-muted)]">
          <span>
            Page {page} of {pages} · {total} entries
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
              Previous
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= pages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AuditPage() {
  return <AuditTrail />;
}
