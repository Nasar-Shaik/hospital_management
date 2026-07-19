"use client";

/**
 * The ward round.
 *
 * ── THE LIST IS DERIVED FROM WHERE THE PATIENTS ARE, NOT FROM A BED MAP ─────
 * `GET /inpatients` is `class: IP` + still open. There is no bed board because there is no
 * bed inventory — no catalogue of wards, rooms or free beds (`bed:manage` is a permission
 * with nothing behind it). So this screen shows who is admitted and which bed they were
 * RECORDED into; it cannot tell you which beds are FREE. It can, though, no longer put two
 * patients in the same bed: admitting into an occupied ward+bed is refused (a unique index,
 * migration 0020). The free-bed board is future work (PROJECT_MEMORY §5).
 *
 * ── THE STAY'S BILL IS THE IP ENCOUNTER'S, NOT THE OP VISIT'S ───────────────
 * Two encounters, one episode (ADR-0013 §4). The consultation that led to the admission
 * has its own bill; the bed-days and everything ordered on the ward land on this one. That
 * separation is what makes both of them billable at all.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  type Encounter,
  type Patient,
  type WardNote,
  type TerminalOutcome,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";
import { rupees, toPaise } from "../../lib/money";

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
            <Badge
              tone={
                n.type === "discharge_summary"
                  ? "success"
                  : n.type === "outcome_note"
                    ? "warning"
                    : "neutral"
              }
            >
              {n.type === "discharge_summary"
                ? "discharge summary"
                : n.type === "outcome_note"
                  ? "outcome"
                  : "progress"}
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

/**
 * The endings that are NOT a routine discharge. Deliberately separate from the discharge
 * form and styled as the exception it is: a death or a patient leaving against advice is
 * not a homegoing, and filing it as one is the false record this screen exists to prevent.
 */
const OUTCOME_ORDER: TerminalOutcome[] = ["lama", "absconded", "deceased"];
const OUTCOMES: Record<TerminalOutcome, { label: string; verb: string; prompt: string }> = {
  lama: {
    label: "Left against medical advice",
    verb: "Record LAMA & close stay",
    prompt: "Record that the risks were explained and the patient chose to leave.",
  },
  absconded: {
    label: "Absconded",
    verb: "Record absconded & close stay",
    prompt: "Record when the patient was found missing.",
  },
  deceased: {
    label: "Deceased",
    verb: "Record death & close stay",
    prompt: "Record the circumstances / cause of death. This is the statutory record.",
  },
};

function OutcomeForm({
  encounterId,
  onRecorded,
}: {
  encounterId: string;
  onRecorded: (outcome: TerminalOutcome) => void;
}) {
  const { api } = useAuth();
  const [outcome, setOutcome] = useState<TerminalOutcome>("lama");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = OUTCOMES[outcome];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.recordOutcome(encounterId, { outcome, text });
      onRecorded(outcome);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the outcome.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <label className="block text-xs text-[var(--color-fg-muted)]">
        How the stay ended
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as TerminalOutcome)}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
        >
          {OUTCOME_ORDER.map((value) => (
            <option key={value} value={value}>
              {OUTCOMES[value].label}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-[var(--color-fg-muted)]">
        {chosen.prompt}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="mt-0.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
        />
      </label>

      <Button
        variant="danger"
        disabled={busy || text.trim().length === 0}
        onClick={() => void submit()}
      >
        {busy ? "Recording…" : chosen.verb}
      </Button>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        This closes the stay and cannot be undone. The bed-days are still billed — the bed was
        occupied until now, whichever way the stay ended.
      </p>
    </div>
  );
}

/**
 * The advance panel — where the admission advance is collected and watched.
 *
 * This is the wallet surfaced at the moment it matters: a patient is admitted, and the desk
 * holds a deposit against a bill that grows by the day. It shows the balance against what the
 * stay owes so the cashier knows when to ask for more, and it collects a top-up in place. Gated
 * on `wallet:manage` (cashier / front office), so a doctor's ward round never sees it. `stayOwes`
 * is the IP encounter's running bill, passed in only when the viewer may read billing.
 */
function WardAdvance({ patientId, stayOwes }: { patientId: string; stayOwes: number | null }) {
  const { api } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .getWallet(patientId)
      .then((w) => setBalance(w.balance))
      .catch(() => setBalance(null));
  }, [api, patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function collect() {
    const paise = toPaise(amount);
    if (paise <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const w = await api.depositToWallet(patientId, {
        amount: paise,
        method,
        reason: "Admission advance",
      });
      setBalance(w.balance);
      setAmount("");
      setOpen(false);
      setNotice(`Advance collected. Balance ${rupees(w.balance)}.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not collect the advance.");
    } finally {
      setBusy(false);
    }
  }

  // Held minus owed: positive is what is left to cover further care, negative is the shortfall the
  // desk should collect. Only meaningful when the viewer can see the bill.
  const cover = balance !== null && stayOwes !== null ? balance - stayOwes : null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Admission advance</h3>
          <p className="mt-1 text-2xl font-bold text-[var(--color-fg)]">
            {balance === null ? "—" : rupees(balance)}
          </p>
          {cover !== null && (
            <p
              className={`mt-1 text-xs ${cover >= 0 ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}
            >
              {cover >= 0
                ? `Covers the ${rupees(stayOwes ?? 0)} this stay owes`
                : `Short of the ${rupees(stayOwes ?? 0)} owed by ${rupees(-cover)} — collect more`}
            </p>
          )}
        </div>
        {!open && (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Collect advance
          </Button>
        )}
      </div>

      {notice && <p className="mt-2 text-xs text-[var(--color-success)]">{notice}</p>}

      {open && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          {error && (
            <div className="mb-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--color-fg-muted)]">
              Amount (₹)
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--color-fg-muted)]">
              Method
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="upi">UPI</option>
                <option value="netbanking">Net banking</option>
              </select>
            </label>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void collect()}>
                {busy ? "Saving…" : "Take advance"}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
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

      // Outstanding across every bill on the stay — what the patient still owes, whether or not the
      // ward charges have been issued as a document yet.
      void api
        .getEncounterBilling(encounterId)
        .then((b) => setBill({ total: b.outstanding }))
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

              <PermissionGate can={can} permission="wallet:manage">
                <WardAdvance patientId={selected.patientId} stayOwes={bill?.total ?? null} />
              </PermissionGate>

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

                <Card className="p-5">
                  <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
                    Other outcome
                  </h3>
                  <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                    When the stay does not end in a routine discharge — the patient left against
                    advice, absconded, or died. Recorded as what it was, not as a discharge.
                  </p>
                  <OutcomeForm
                    encounterId={selected.id}
                    onRecorded={(outcome) => {
                      const said =
                        outcome === "deceased"
                          ? "Death recorded. The account is on the chart and the stay is closed."
                          : outcome === "lama"
                            ? "Recorded: left against medical advice. The stay is closed."
                            : "Recorded: absconded. The stay is closed.";
                      setNotice(said);
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
