"use client";

/**
 * The pharmacy counter.
 *
 * ── THE WORKLIST IS THE SAME OBJECT AS THE LAB'S ────────────────────────────
 * `?category=pharmacy&outstanding=true` IS this screen's queue — the identical query the
 * lab's worklist runs, over the identical collection (ADR-0013 §3). A signed prescription
 * appears here the instant the doctor signs it, because signing publishes an event that
 * places a `pharmacy` order. Nobody carries a chit down a corridor, and there is no
 * "send to pharmacy" button for anyone to forget.
 *
 * ── WHAT THE PHARMACIST CAN AND CANNOT DO ───────────────────────────────────
 * They hand drugs over (`pharmacy:dispense`) and they read the chart (`emr:read`). They
 * CANNOT write, sign or amend a prescription — that separation is the entire reason a
 * pharmacy is a safety check rather than a hatch, and the RBAC suite asserts it.
 *
 * ── PARTIAL HANDOVERS ARE THE NORMAL CASE ───────────────────────────────────
 * The quantity box defaults to what is still owed, not to what was prescribed. A pharmacy
 * that has six of the ten tablets gives six, and the patient is billed for six — which is
 * why the number is editable and why the screen shows "given / prescribed" everywhere.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  type Allergy,
  type Dispense,
  type Order,
  type Patient,
  type Prescription,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card } from "../../components/ui";
import { rupees } from "../../lib/money";

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A stable idempotency key for one handover.
 *
 * A pharmacist double-clicking "Dispense" must not hand over — and bill for — two lots of
 * the same drug, and a retry after a timeout is exactly the case a disabled button cannot
 * save you from: the first request may well have succeeded before the connection dropped.
 * With a controlled substance a double handover is not a billing error, it is a diversion.
 */
function requestKey(prescriptionId: string): string {
  return `dsp-${prescriptionId}-${String(Date.now())}`;
}

/** One prescription at the counter: what is owed, what is given, and the button. */
function Counter({
  prescription,
  onDispensed,
}: {
  prescription: Prescription;
  onDispensed: () => void;
}) {
  const { api, can } = useAuth();
  const [qty, setQty] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Dispense[]>([]);
  /** Set when the last attempt was refused as over the patient's advance (HMS-PHM-003). */
  const [overBudget, setOverBudget] = useState<{
    cost: number;
    balance: number;
    shortfall: number;
  } | null>(null);
  const [creditReason, setCreditReason] = useState("");

  /** What is still owed on each line. The default the pharmacist almost always wants. */
  const outstanding = useCallback(
    (index: number): number => {
      const line = prescription.lines[index];
      if (!line) return 0;
      return Math.max(0, line.quantity - line.dispensedQty);
    },
    [prescription],
  );

  useEffect(() => {
    const initial: Record<number, number> = {};
    prescription.lines.forEach((_, i) => (initial[i] = outstanding(i)));
    setQty(initial);

    void api
      .listDispenses(prescription.id)
      .then(setLedger)
      .catch(() => setLedger([]));
  }, [api, prescription, outstanding]);

  const items = useMemo(
    () =>
      prescription.lines
        .map((_, i) => ({ lineIndex: i, quantity: qty[i] ?? 0 }))
        .filter((item) => item.quantity > 0),
    [prescription.lines, qty],
  );

  async function dispense(override?: { reason: string }) {
    setBusy(true);
    setError(null);
    try {
      await api.dispense(prescription.id, {
        items,
        requestId: requestKey(prescription.id),
        ...(override ? { creditOverride: override } : {}),
      });
      setOverBudget(null);
      setCreditReason("");
      onDispensed();
    } catch (err) {
      // Admitted patient over their advance — not a failure, a checkpoint. Surface the
      // shortfall so a doctor can authorise dispensing on credit (HMS-PHM-003).
      if (err instanceof ApiClientError && err.code === "HMS-PHM-003") {
        const d = (err.details ?? {}) as { cost?: number; balance?: number; shortfall?: number };
        setOverBudget({ cost: d.cost ?? 0, balance: d.balance ?? 0, shortfall: d.shortfall ?? 0 });
      } else {
        setError(err instanceof ApiClientError ? err.message : "Could not dispense.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="space-y-2">
        {prescription.lines.map((line, i) => {
          const owed = outstanding(i);
          return (
            <div
              key={`${line.drugCode}-${String(i)}`}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-fg)]">{line.drugName}</span>
                <Badge tone={owed === 0 ? "success" : "neutral"}>
                  {line.dispensedQty}/{line.quantity} given
                </Badge>
              </div>

              {/* The instruction the patient actually needs, in the words the doctor used. */}
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {line.dose} · {line.route} · {line.frequency}
                {line.durationDays ? ` · ${String(line.durationDays)} days` : ""}
                {line.instructions ? ` · ${line.instructions}` : ""}
              </p>

              {owed > 0 ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                  Hand over now
                  <input
                    type="number"
                    min={0}
                    max={owed}
                    value={qty[i] ?? 0}
                    onChange={(e) =>
                      setQty((prev) => ({ ...prev, [i]: Math.min(Number(e.target.value), owed) }))
                    }
                    className="w-20 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-1.5 py-1 text-xs text-[var(--color-fg)]"
                  />
                  <span className="text-[var(--color-fg-subtle)]">of {owed} still owed</span>
                </label>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-success)]">Fully given.</p>
              )}
            </div>
          );
        })}
      </div>

      {overBudget ? (
        <Alert tone="warning" title="Over the patient's advance">
          <p>
            This handover costs {rupees(overBudget.cost)} but the patient&apos;s advance is only{" "}
            {rupees(overBudget.balance)} — <strong>{rupees(overBudget.shortfall)} short</strong>.
          </p>
          {can("pharmacy:credit-override") ? (
            <div className="mt-3 space-y-2">
              <label className="block text-xs font-medium text-[var(--color-fg)]">
                Reason for dispensing on credit
                <input
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value)}
                  placeholder="e.g. inpatient — advance to be topped up on discharge"
                  className="mt-1 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                />
              </label>
              <div className="flex gap-2">
                <Button
                  disabled={busy || creditReason.trim().length < 3}
                  onClick={() => void dispense({ reason: creditReason.trim() })}
                >
                  {busy ? "Dispensing…" : "Authorise on credit & dispense"}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setOverBudget(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs">
              A doctor or administrator must authorise dispensing on credit. Ask them to complete
              this handover, or collect an advance first.
            </p>
          )}
        </Alert>
      ) : (
        <Button disabled={busy || items.length === 0} onClick={() => void dispense()}>
          {busy ? "Dispensing…" : "Dispense"}
        </Button>
      )}

      {ledger.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-[var(--color-fg-muted)] uppercase">
            Already handed over
          </p>
          <ul className="space-y-1">
            {ledger.map((d) => (
              <li key={d.id} className="text-xs text-[var(--color-fg-subtle)]">
                {time(d.dispensedAt)} —{" "}
                {d.lines.map((l) => `${l.drugName} × ${String(l.quantity)}`).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Pharmacy() {
  const { api } = useAuth();

  const [queue, setQueue] = useState<Order[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prescription, setPrescription] = useState<Prescription | null>(null);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
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

  /** The counter's queue IS this query. No hand-off, so nothing to forget. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listOrders({ category: "pharmacy", outstanding: true, limit: 100 });
      setQueue(page.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the counter.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = queue.find((o) => o.id === selectedId) ?? null;

  /**
   * The order says WHO and WHETHER; the prescription says WHICH DRUG. Resolving one from
   * the other is what keeps a queue entry from having to carry a dose.
   */
  /**
   * What this visit owes, so the pharmacist can answer the only question every patient
   * asks them. A government hospital shows ₹0 here, through the same call.
   *
   * ── WHY THIS RE-READS INSTEAD OF READING ONCE ───────────────────────────────
   * The drug charge does NOT exist when `dispense` returns. Billing LISTENS: handing the
   * drugs over publishes `medication.dispensed`, and the charge is posted by a consumer
   * once the relay delivers it — a beat later. That is the design, and it is what keeps a
   * broken tariff from ever blocking a patient's medicine.
   *
   * The cost is visible right here: read once, immediately, and this figure says ₹500.00
   * for a visit that owes ₹589.00 — the pharmacist reads out the total WITHOUT the drugs
   * they are holding in their hand. Eventual consistency is a fine thing to choose and a
   * terrible thing to hide behind a number that looks settled.
   *
   * So the figure converges: read now, and read again once the relay has had its moment.
   */
  const loadBill = useCallback(
    (encounterId: string) => {
      const read = () =>
        api
          .getBill(encounterId)
          .then((b) => setBill({ total: b.total }))
          .catch(() => setBill(null));

      void read();
      const timer = setTimeout(() => void read(), 1500);
      return () => clearTimeout(timer);
    },
    [api],
  );

  const loadPrescription = useCallback(
    (order: Order) => {
      void api
        .listPrescriptions({ encounterId: order.encounterId, current: true, limit: 20 })
        .then((list) => {
          setPrescription(list.find((rx) => rx.orderId === order.id) ?? null);
        })
        .catch(() => setPrescription(null));

      loadBill(order.encounterId);
    },
    [api, loadBill],
  );

  useEffect(() => {
    if (selected) loadPrescription(selected);
    else setPrescription(null);
  }, [selected, loadPrescription]);

  // The pharmacist is the LAST check before a drug is handed over. Allergies are the
  // patient's, read hospital-wide — an allergy recorded at any branch shows here.
  const selectedPatientId = selected?.patientId ?? null;
  useEffect(() => {
    if (!selectedPatientId) {
      setAllergies([]);
      return;
    }
    void api
      .listAllergies(selectedPatientId)
      .then(setAllergies)
      .catch(() => setAllergies([]));
  }, [selectedPatientId, api]);

  const activeAllergies = allergies.filter((a) => a.status === "active");

  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Pharmacy</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Prescriptions waiting to be handed over. They arrive here the moment a doctor signs.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            At the counter ({queue.length})
          </h2>

          {loading ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
          ) : queue.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
              Nothing waiting.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {queue.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(o.id)}
                    className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                      selectedId === o.id
                        ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg-subtle)] hover:border-[var(--color-border-strong)]"
                    }`}
                  >
                    <p className="text-sm font-medium text-[var(--color-fg)]">
                      {nameOf(o.patientId)}
                    </p>
                    <p className="text-xs text-[var(--color-fg-subtle)]">
                      {uhidOf(o.patientId)} · {o.name} · {time(o.orderedAt)}
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
                Choose a patient to see what the doctor prescribed.
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
                    </p>
                  </div>
                  {bill && (
                    <div className="text-right">
                      <p className="text-xs text-[var(--color-fg-muted)]">This visit owes</p>
                      <p className="text-lg font-semibold text-[var(--color-fg)]">
                        {rupees(bill.total)}
                      </p>
                    </div>
                  )}
                </div>

                {activeAllergies.length > 0 && (
                  <div className="mt-3">
                    <Alert tone="danger" title="Allergies">
                      <div className="flex flex-wrap gap-1.5">
                        {activeAllergies.map((a) => (
                          <span
                            key={a.id}
                            className="rounded border border-[var(--color-danger)]/30 px-1.5 py-0.5 text-xs font-medium"
                          >
                            {a.label}
                            {a.severity === "anaphylaxis" || a.severity === "severe"
                              ? ` (${a.severity})`
                              : ""}
                          </span>
                        ))}
                      </div>
                    </Alert>
                  </div>
                )}
              </Card>

              <Card className="p-5">
                <h3 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
                  What the doctor prescribed
                </h3>
                <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
                  You can hand over less than was prescribed — the patient is only charged for what
                  they are actually given.
                </p>

                {prescription ? (
                  <Counter
                    prescription={prescription}
                    onDispensed={() => {
                      setNotice("Dispensed. The drugs are on this visit's bill.");
                      void load();
                      loadPrescription(selected);
                    }}
                  />
                ) : (
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    Could not find the prescription for this counter entry.
                  </p>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PharmacyPage() {
  return (
    <Protected>
      <Pharmacy />
    </Protected>
  );
}
