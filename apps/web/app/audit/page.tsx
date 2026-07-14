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
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, type AuditEntry, type AuditIntegrity } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";

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

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [category, setCategory] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [integrity, setIntegrity] = useState<AuditIntegrity | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listAudit({
        page,
        limit: 25,
        ...(category ? { category: category as AuditEntry["category"] } : {}),
      });
      setEntries(result.items);
      setTotal(result.meta.total ?? result.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the activity trail.");
    } finally {
      setLoading(false);
    }
  }, [api, category, page]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const pages = Math.max(1, Math.ceil(total / 25));

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
            <a
              href={api.auditExportUrl(
                category ? { category: category as AuditEntry["category"] } : {},
              )}
              className="inline-flex items-center rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
            >
              Export CSV
            </a>
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

      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-subtle)] uppercase">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Who</th>
              <th className="px-4 py-3 font-medium">What</th>
              <th className="px-4 py-3 font-medium">Changed</th>
              <th className="px-4 py-3 font-medium">From</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  Loading…
                </td>
              </tr>
            )}

            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-fg-muted)]">
                  Nothing recorded yet in this category.
                </td>
              </tr>
            )}

            {!loading &&
              entries.map((entry) => (
                <tr
                  key={entry.id}
                  className={entry.outcome === "failure" ? "bg-[var(--color-danger-bg)]/30" : ""}
                >
                  <td className="px-4 py-3 whitespace-nowrap text-[var(--color-fg-muted)]">
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block text-[var(--color-fg)]">
                      {entry.actorEmail ?? entry.actorId ?? "System"}
                    </span>
                    {entry.actorRoles?.[0] && (
                      <span className="text-xs text-[var(--color-fg-subtle)]">
                        {entry.actorRoles[0]}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--color-fg)]">{humanize(entry.action)}</span>
                      <Badge tone={categoryTone(entry.category)}>{entry.category}</Badge>
                      {entry.outcome === "failure" && <Badge tone="danger">refused</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">{changedFields(entry)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--color-fg-subtle)]">
                    {entry.ip ?? "—"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

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
  return (
    <Protected>
      <AuditTrail />
    </Protected>
  );
}
