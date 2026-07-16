"use client";

/**
 * The ward round.
 *
 * ── THE LIST IS DERIVED FROM WHERE THE PATIENTS ARE, NOT FROM A BED MAP ─────
 * `GET /inpatients` is `class: IP` + still open. There is no bed board because there is no
 * bed inventory — no wards, no rooms, no occupancy (`bed:manage` is a permission with
 * nothing behind it). So this screen shows who is admitted and which bed they were
 * RECORDED into; it cannot tell you which beds are free, and it will not stop two patients
 * being put in A-12. That gap is real and written down (PROJECT_MEMORY §5) rather than
 * half-closed: a bed board that is only sometimes right is worse than a wall chart,
 * because people stop checking the wall.
 *
 * ── THE STAY'S BILL IS THE IP ENCOUNTER'S, NOT THE OP VISIT'S ───────────────
 * Two encounters, one episode (ADR-0013 §4). The consultation that led to the admission
 * has its own bill; the bed-days and everything ordered on the ward land on this one. That
 * separation is what makes both of them billable at all.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, type Encounter, type Patient, type WardNote } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";
import { rupees } from "../../lib/money";

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How many calendar days the patient has been in — the unit the bed is billed in. */
function daysIn(admittedAt: string): number {
  const from = new Date(admittedAt);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(from).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  return days + 1;
}

/** The chart: what happened, day by day. */
function Notes({ notes }: { notes: WardNote[] }) {
  if (notes.length === 0) {
    return <p className="text-xs text-[var(--color-fg-subtle)]">Nothing recorded yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li
          key={n.id}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-2.5"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={n.type === "discharge_summary" ? "success" : "neutral"}>
              {n.type === "discharge_summary" ? "discharge summary" : "progress"}
            </Badge>
            <span className="text-xs text-[var(--color-fg-subtle)]">{when(n.at)}</span>
          </div>
          {n.diagnosis && (
            <p className="text-xs font-medium text-[var(--color-fg)]">Diagnosis: {n.diagnosis}</p>
          )}
          {/* `whitespace-pre-wrap`: a ward note is prose somebody typed with line breaks
              that mean something. Collapsing them turns a structured note into a wall. */}
          <p className="text-sm whitespace-pre-wrap text-[var(--color-fg)]">{n.text}</p>
          {n.advice && (
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">Advice: {n.advice}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Today's entry. Immutable once written — a correction is a new note. */
function AddNote({ encounterId, onAdded }: { encounterId: string; onAdded: () => void }) {
  const { api } = useAuth();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.addWardNote(encounterId, text);
      setText("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <Alert tone="danger">{error}</Alert>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="How is the patient today? What changed, what is planned…"
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
      />
      <Button disabled={busy || text.trim().length === 0} onClick={() => void save()}>
        {busy ? "Saving…" : "Add note"}
      </Button>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        A note cannot be edited or deleted once saved. A correction is a new note that says so.
      </p>
    </div>
  );
}

/** The document the patient goes home with. */
function DischargeForm({
  encounterId,
  onDischarged,
}: {
  encounterId: string;
  onDischarged: () => void;
}) {
  const { api } = useAuth();
  const [text, setText] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [advice, setAdvice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.discharge(encounterId, {
        text,
        ...(diagnosis ? { diagnosis } : {}),
        ...(advice ? { advice } : {}),
      });
      onDischarged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not discharge the patient.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <label className="block text-xs text-[var(--color-fg-muted)]">
        Diagnosis
        <input
          value={diagnosis}
          onChange={(e) => setDiagnosis(e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
        />
      </label>

      <label className="block text-xs text-[var(--color-fg-muted)]">
        What happened during the stay
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
      </label>

      <label className="block text-xs text-[var(--color-fg-muted)]">
        Advice on going home
        <textarea
          value={advice}
          onChange={(e) => setAdvice(e.target.value)}
          rows={2}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
      </label>

      <Button disabled={busy || text.trim().length === 0} onClick={() => void submit()}>
        {busy ? "Discharging…" : "Discharge with this summary"}
      </Button>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        There is no way to discharge without a summary. It is the only record of this stay the next
        doctor to see this patient is likely to read.
      </p>
    </div>
  );
}

function Ward() {
  const { api, can } = useAuth();

  const [beds, setBeds] = useState<Encounter[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<WardNote[]>([]);
  const [bill, setBill] = useState<{ total: number } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api
      .listPatients({ limit: 100 })
      .then((page) => setPatients(page.items))
      .catch((err: unknown) =>
        setError(err instanceof ApiClientError ? err.message : "Could not load patients."),
      );
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBeds(await api.listInpatients());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the ward.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadChart = useCallback(
    (encounterId: string) => {
      void api
        .listWardNotes(encounterId)
        .then(setNotes)
        .catch(() => setNotes([]));

      /**
       * The IP encounter's OWN bill: bed-days plus whatever was ordered on the ward.
       *
       * ── ASKED FOR ONLY BY SOMEBODY WHO MAY HAVE IT ──────────────────────────
       * A DOCTOR does not hold `billing:read` — deliberately, so a patient's means cannot
       * shape their treatment. `PermissionGate` hides the FIGURE, but an unconditional
       * fetch still fired: every doctor opening a ward chart got a 403, swallowed by the
       * catch and invisible on screen.
       *
       * It was not invisible in the AUDIT TRAIL. Denials are recorded on purpose — "forty
       * denials from one account in a minute is somebody mapping the permission surface"
       * (`middleware/authorize.ts`). A screen that manufactures a denial every time a
       * doctor opens a chart buries that signal in noise we generated ourselves, which is
       * how a real intrusion goes unnoticed.
       *
       * So the gate decides the REQUEST, not just the rendering.
       */
      if (!can("billing:read")) {
        setBill(null);
        return;
      }

      void api
        .getBill(encounterId)
        .then((b) => setBill({ total: b.total }))
        .catch(() => setBill(null));
    },
    [api, can],
  );

  useEffect(() => {
    if (selectedId) loadChart(selectedId);
  }, [selectedId, loadChart]);

  const selected = beds.find((e) => e.id === selectedId) ?? null;
  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Ward</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Everyone in a bed. The stay is billed by the day, from the day they came in.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            Admitted ({beds.length})
          </h2>

          {loading ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
          ) : beds.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
              Nobody is admitted.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {beds.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                      selectedId === e.id
                        ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg-subtle)] hover:border-[var(--color-border-strong)]"
                    }`}
                  >
                    <p className="text-sm font-medium text-[var(--color-fg)]">
                      {nameOf(e.patientId)}
                    </p>
                    <p className="text-xs text-[var(--color-fg-subtle)]">
                      {e.bed ? `${e.bed.ward} · ${e.bed.bedCode}` : "no bed recorded"}
                      {e.admittedAt ? ` · day ${String(daysIn(e.admittedAt))}` : ""}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          {!selected ? (
            <Card className="p-10 text-center">
              <p className="text-sm text-[var(--color-fg-subtle)]">
                Choose a patient to see their chart.
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--color-fg)]">
                      {nameOf(selected.patientId)}
                    </h2>
                    <p className="text-sm text-[var(--color-fg-muted)]">
                      {uhidOf(selected.patientId)}
                      {selected.bed ? ` · ${selected.bed.ward} · bed ${selected.bed.bedCode}` : ""}
                    </p>
                    {selected.admittedAt && (
                      <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                        Admitted {when(selected.admittedAt)} · day {daysIn(selected.admittedAt)}
                      </p>
                    )}
                  </div>
                  {/* The IP encounter's own bill. The OP consultation has its own — two
                      encounters, one episode, and that is what makes both billable. */}
                  <PermissionGate can={can} permission="billing:read">
                    {bill && (
                      <div className="text-right">
                        <p className="text-xs text-[var(--color-fg-muted)]">This stay owes</p>
                        <p className="text-lg font-semibold text-[var(--color-fg)]">
                          {rupees(bill.total)}
                        </p>
                      </div>
                    )}
                  </PermissionGate>
                </div>
              </Card>

              <PermissionGate can={can} permission="emr:write">
                <Card className="p-5">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
                    Today&apos;s note
                  </h3>
                  <AddNote encounterId={selected.id} onAdded={() => loadChart(selected.id)} />
                </Card>
              </PermissionGate>

              <Card className="p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">The chart</h3>
                <Notes notes={notes} />
              </Card>

              <PermissionGate can={can} permission="admission:discharge">
                <Card className="p-5">
                  <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Discharge</h3>
                  <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                    The bed-days are added to the bill when the patient is discharged.
                  </p>
                  <DischargeForm
                    encounterId={selected.id}
                    onDischarged={() => {
                      setNotice(
                        "Discharged. The summary is on the chart and the bed-days are billed.",
                      );
                      setSelectedId(null);
                      void load();
                    }}
                  />
                </Card>
              </PermissionGate>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WardPage() {
  return (
    <Protected>
      <Ward />
    </Protected>
  );
}
