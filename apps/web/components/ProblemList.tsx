"use client";

/**
 * The patient's PROBLEM LIST — what is true of this person today, on every screen that needs it.
 *
 * ── WHY THIS IS A COMPONENT AND NOT A TAB ───────────────────────────────────
 * It is asked in two places and they are not the same screen: the patient chart, where it sits
 * beside the allergy banner as context you read before anything else, and the consultation, where
 * the doctor both reads it and adds to it while writing the note. A tab on the chart alone would
 * answer the first and leave the second — a doctor with the note open would have to leave it to
 * find out what else is wrong with the patient.
 *
 * ── WHAT "ACTIVE" MEANS HERE, AND WHY IT IS THE DEFAULT ─────────────────────
 * A problem list nobody prunes is a list nobody reads, so the panel shows only what still applies
 * and puts the resolved ones behind a disclosure. That is also the property worth testing: a
 * resolved problem rendered among the active ones would tell a clinician the patient still has a
 * condition they recovered from.
 *
 * ── PROMOTION COMES FROM THE SAVED NOTE, NOT THE EDITOR'S BUFFER ────────────
 * `promoteFrom` carries the diagnoses as the SERVER has them, because promotion is by index into
 * the saved note (`POST /encounters/:id/problems/promote`). Wiring it to the editor's unsaved
 * rows would promote whatever the server happened to hold at that index, which is a different
 * diagnosis the moment the doctor adds a line and has not saved.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { ApiClientError, type ApiClient, type Diagnosis, type Problem } from "@medicore/api-client";
import { Alert, Button } from "./ui";

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const field =
  "rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]";

function ProblemRow({
  problem,
  canWrite,
  onResolve,
}: {
  problem: Problem;
  canWrite: boolean;
  onResolve: (p: Problem) => void;
}): JSX.Element {
  const resolved = problem.status === "resolved";
  return (
    <li
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-sm ${
        resolved
          ? "text-[var(--color-fg-subtle)]"
          : "bg-[var(--color-bg-subtle)] text-[var(--color-fg)]"
      }`}
    >
      <span className={resolved ? "line-through" : "font-medium"}>{problem.title}</span>
      {problem.code && (
        <span className="rounded bg-[var(--color-brand-600)]/10 px-1.5 py-0.5 font-mono text-xs text-[var(--color-brand-700)]">
          {problem.code}
        </span>
      )}
      {problem.onsetDate && (
        <span className="text-xs text-[var(--color-fg-muted)]">
          since {fmtDate(problem.onsetDate)}
        </span>
      )}
      {resolved && (
        <span className="text-xs text-[var(--color-fg-muted)]">
          resolved {fmtDate(problem.resolvedAt)}
        </span>
      )}
      {!resolved && canWrite && (
        <button
          type="button"
          onClick={() => onResolve(problem)}
          className="ml-auto text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-brand-600)] hover:underline"
        >
          Resolve
        </button>
      )}
    </li>
  );
}

export function ProblemPanel({
  api,
  patientId,
  canWrite,
  promoteFrom,
}: {
  api: ApiClient;
  patientId: string;
  /** `emr:write`. A reader sees the list and no controls — not disabled ones. */
  canWrite: boolean;
  /** Offer promotion from this visit's SAVED consultation diagnoses. Omitted on the chart. */
  promoteFrom?: { encounterId: string; diagnoses: Diagnosis[] };
}): JSX.Element {
  const [problems, setProblems] = useState<Problem[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [onset, setOnset] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProblems(await api.listProblems(patientId));
      setError(null);
    } catch {
      // A reader without `emr:read`, or a hospital without the EMR module. Show nothing rather
      // than an error on a panel that is context, not the point of the screen.
      setProblems([]);
    }
  }, [api, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = problems.filter((p) => p.status === "active");
  const resolved = problems.filter((p) => p.status === "resolved");

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the problem list.");
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    const t = title.trim();
    if (!t) return;
    await run(async () => {
      await api.addProblem(patientId, {
        title: t,
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(onset ? { onsetDate: onset } : {}),
      });
      setTitle("");
      setCode("");
      setOnset("");
      setAdding(false);
    });
  }

  return (
    <section aria-label="Problem list" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">
          Problem list
        </h3>
        {canWrite && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-xs text-[var(--color-brand-600)] hover:underline"
          >
            + Add problem
          </button>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {active.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-subtle)]">No active problems recorded.</p>
      ) : (
        <ul className="space-y-1">
          {active.map((p) => (
            <ProblemRow
              key={p.id}
              problem={p}
              canWrite={canWrite}
              onResolve={(target) => void run(() => api.resolveProblem(target.id))}
            />
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-xs text-[var(--color-fg-muted)] hover:underline"
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
          {showResolved && (
            <ul className="space-y-1">
              {resolved.map((p) => (
                <ProblemRow key={p.id} problem={p} canWrite={false} onResolve={() => undefined} />
              ))}
            </ul>
          )}
        </>
      )}

      {canWrite && adding && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <input
            aria-label="Problem"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Condition"
            className={`min-w-40 flex-1 ${field}`}
          />
          {/* Free text, checked by the server against the hospital's ICD master — an unknown code
              is refused by name rather than stored as something that matches nothing. */}
          <input
            aria-label="ICD code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ICD (optional)"
            className={`w-32 font-mono text-xs ${field}`}
          />
          <input
            aria-label="Onset date"
            type="date"
            value={onset}
            onChange={(e) => setOnset(e.target.value)}
            className={`w-40 text-xs ${field}`}
          />
          <Button size="sm" disabled={busy} onClick={() => void add()}>
            Add
          </Button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="text-xs text-[var(--color-fg-muted)] hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {canWrite && promoteFrom && promoteFrom.diagnoses.length > 0 && (
        <div className="border-t border-[var(--color-border)] pt-2">
          <p className="mb-1 text-xs text-[var(--color-fg-muted)]">
            From this visit&rsquo;s saved diagnoses
          </p>
          <ul className="space-y-1">
            {promoteFrom.diagnoses.map((d, i) => (
              <li key={`${d.text}-${String(i)}`} className="flex items-center gap-2 text-sm">
                <span className="text-[var(--color-fg)]">{d.text}</span>
                {d.code && (
                  <span className="font-mono text-xs text-[var(--color-fg-muted)]">{d.code}</span>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.promoteDiagnosis(promoteFrom.encounterId, { diagnosisIndex: i }),
                    )
                  }
                  className="ml-auto text-xs text-[var(--color-brand-600)] hover:underline disabled:opacity-50"
                >
                  Add to problem list
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
