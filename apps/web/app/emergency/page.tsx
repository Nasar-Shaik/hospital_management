"use client";

/**
 * The emergency board (D10) — everyone in the department right now, worst first.
 *
 * ── WHAT THIS SCREEN IS ─────────────────────────────────────────────────────
 * A ranked view of ENCOUNTERS, not a second patient list. Registration happens at reception
 * (`class: ER`), the clinical work happens on the doctor's own screens, and admission and
 * discharge are the routes the rest of the hospital already uses. What lives only here is the
 * triage judgement and the ordering it produces.
 *
 * ── WHY IT POLLS, AND WHY THAT IS ENOUGH ────────────────────────────────────
 * A socket would be a second transport to secure, scope to a tenant, and reason about on a flaky
 * hospital network, to make a board that a person reads every minute or so refresh in one second
 * instead of fifteen. Polling is what the rest of this product does and it is the honest answer at
 * this size. The interval is cleared on unmount so a board left open on a nurses' station does not
 * keep a tab spinning after a navigation.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { EdBoardRow, TriagePriority } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorAlert,
  Modal,
  type Column,
} from "../../components/ui";

const REFRESH_MS = 15_000;

const PRIORITIES: {
  value: TriagePriority;
  label: string;
  tone: "danger" | "warning" | "neutral";
}[] = [
  { value: "critical", label: "Critical", tone: "danger" },
  { value: "urgent", label: "Urgent", tone: "warning" },
  { value: "non_urgent", label: "Non-urgent", tone: "neutral" },
];

const priorityOf = (p: TriagePriority) => PRIORITIES.find((x) => x.value === p);

/** `1h 20m`, because "80 minutes" is a number a tired person has to convert. */
function waited(minutes: number): string {
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

const STATUS_LABEL: Record<string, string> = {
  arrived: "Arrived",
  in_queue: "Waiting",
  in_progress: "With doctor",
  awaiting_results: "Awaiting results",
};

/* ── Triage ── */

function TriageModal({
  row,
  onClose,
  onSaved,
}: {
  row: EdBoardRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [priority, setPriority] = useState<TriagePriority | "">(row.priority ?? "");
  const [chiefComplaint, setChiefComplaint] = useState(row.chiefComplaint ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!priority) return;
    setSaving(true);
    setError(null);
    api
      .triagePatient({
        encounterId: row.encounterId,
        priority,
        ...(chiefComplaint.trim() ? { chiefComplaint: chiefComplaint.trim() } : {}),
      })
      .then(() => onSaved())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  return (
    <Modal
      title={row.priority ? "Re-assess this patient" : "Triage this patient"}
      onClose={onClose}
    >
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not record the triage." />}

        <p className="text-xs text-[var(--color-fg-muted)]">
          {row.patientName} · {row.uhid} · waiting {waited(row.waitingMinutes)}
        </p>

        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--color-fg)]">How urgent?</span>
          <div className="flex flex-wrap gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={priority === p.value}
                onClick={() => setPriority(p.value)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  priority === p.value
                    ? "border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/10 font-medium text-[var(--color-fg)]"
                    : "border-[var(--color-border)] text-[var(--color-fg-muted)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Chief complaint</span>
          <textarea
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            rows={2}
            value={chiefComplaint}
            onChange={(e) => setChiefComplaint(e.target.value)}
            placeholder="Chest pain since this morning"
          />
        </label>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!priority}>
            Save triage
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Transfer out ── */

function TransferModal({
  row,
  onClose,
  onSaved,
}: {
  row: EdBoardRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [destination, setDestination] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .transferOutOfEd({
        encounterId: row.encounterId,
        destination: destination.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      .then(() => onSaved())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  return (
    <Modal title="Send to another hospital" onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not record the transfer." />}

        <p className="text-xs text-[var(--color-fg-muted)]">
          {row.patientName} · {row.uhid}
        </p>
        <p className="text-sm text-[var(--color-fg-muted)]">
          This closes the visit here and records where the patient went. It does not book an
          ambulance.
        </p>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Sent to</span>
          <input
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="City General — cardiology"
            required
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Why</span>
          <textarea
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Needs a cath lab. Referred to Dr Menon, accepted 14:20."
          />
        </label>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={destination.trim().length < 2}>
            Record transfer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── The board ── */

export default function EmergencyBoardPage() {
  const { api, can } = useAuth();
  const canTriage = can("triage:perform");
  const canClose = can("encounter:close");

  const [rows, setRows] = useState<EdBoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [triaging, setTriaging] = useState<EdBoardRow | null>(null);
  const [transferring, setTransferring] = useState<EdBoardRow | null>(null);

  const load = useCallback(
    (showSpinner = false) => {
      if (showSpinner) setLoading(true);
      api
        .edBoard()
        .then((r) => {
          setRows(r);
          setError(null);
        })
        .catch((e: unknown) => setError(e))
        .finally(() => setLoading(false));
    },
    [api],
  );

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const columns: Column<EdBoardRow>[] = [
    {
      key: "priority",
      header: "Priority",
      render: (r) =>
        r.priority ? (
          <Badge tone={priorityOf(r.priority)?.tone ?? "neutral"}>
            {priorityOf(r.priority)?.label}
          </Badge>
        ) : (
          // Not a blank. An unassessed patient is the most urgent thing on this board and has to
          // read that way — see PRIORITY_RANK on the API, which sorts them to the top.
          <Badge tone="danger" dot>
            Not triaged
          </Badge>
        ),
    },
    {
      key: "patient",
      header: "Patient",
      cellClassName: "text-[var(--color-fg)]",
      render: (r) => (
        <>
          {r.patientName}{" "}
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{r.uhid}</span>
        </>
      ),
    },
    {
      key: "complaint",
      header: "Complaint",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (r) => r.chiefComplaint ?? "—",
    },
    {
      key: "waiting",
      header: "Waiting",
      cellClassName: "font-mono text-xs whitespace-nowrap text-[var(--color-fg-muted)]",
      render: (r) => waited(r.waitingMinutes),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span className="text-sm text-[var(--color-fg-muted)]">
          {STATUS_LABEL[r.status] ?? r.status.replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          {canTriage && (
            <Button size="sm" variant="secondary" onClick={() => setTriaging(r)}>
              {r.priority ? "Re-assess" : "Triage"}
            </Button>
          )}
          {canClose && (
            <Button size="sm" variant="ghost" onClick={() => setTransferring(r)}>
              Transfer out
            </Button>
          )}
        </div>
      ),
    },
  ];

  const untriaged = rows.filter((r) => !r.priority).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Emergency</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Everyone in the department right now. Patients nobody has assessed sort to the top — an
            unknown priority is not a low one. Patients leave this board when they are discharged,
            admitted or sent elsewhere.
          </p>
        </div>
        <Button variant="secondary" onClick={() => load(true)}>
          Refresh
        </Button>
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load the board." />}

      {untriaged > 0 && (
        <Card className="border-[var(--color-danger)]/30 p-4">
          <p className="text-sm text-[var(--color-fg)]">
            <strong>
              {untriaged} {untriaged === 1 ? "patient has" : "patients have"} not been assessed.
            </strong>{" "}
            They are at the top of the list.
          </p>
        </Card>
      )}

      <DataTable<EdBoardRow>
        columns={columns}
        rows={rows}
        keyOf={(r) => r.encounterId}
        loading={loading}
        empty="Nobody in the emergency department."
      />

      {triaging && (
        <TriageModal
          row={triaging}
          onClose={() => setTriaging(null)}
          onSaved={() => {
            setTriaging(null);
            load();
          }}
        />
      )}
      {transferring && (
        <TransferModal
          row={transferring}
          onClose={() => setTransferring(null)}
          onSaved={() => {
            setTransferring(null);
            load();
          }}
        />
      )}
    </div>
  );
}
