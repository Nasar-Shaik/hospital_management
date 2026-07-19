"use client";

/**
 * Reception (Doc 02 E0, ADR-0013) — the front door of the hospital.
 *
 * ── THIS SCREEN IS THE WALK-IN, AND THE WALK-IN IS THE MAJORITY ──────────────
 * Five of our six target organization types are walk-in led. A patient arrives, a
 * clerk finds them, picks a doctor, and they are in the queue with a number — no
 * appointment anywhere in the story. Everything else on this page is secondary to
 * making that take four seconds.
 *
 * ── THE DAY IS THE UNIT, BECAUSE THE DESK THINKS IN DAYS ─────────────────────
 * "Who came today?" is the question a receptionist actually asks, so the register is
 * a date picker and a list. The server resolves the day in the HOSPITAL's timezone —
 * not the browser's, which would quietly show a different day to a clerk whose laptop
 * is set wrong (core/time/day.ts).
 *
 * ── WHAT THE BUTTONS OFFER IS DERIVED FROM THE STATE MACHINE ─────────────────
 * A button that produces a 422 is a button that should never have been drawn
 * (STATE_MACHINE_CATALOG §14). The private hospital's "Add to queue" simply does not
 * appear at a government hospital, because there the patient is queued at
 * registration by policy — the same screen, behaving differently, with no branch here.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  type EncounterBilling,
  type Invoice,
  type Encounter,
  type EncounterStatus,
  type DoctorRef,
  type Patient,
} from "@medicore/api-client";
import { rupees, toPaise } from "../../lib/money";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusTone(s: EncounterStatus): "success" | "danger" | "brand" | "neutral" {
  if (s === "cancelled" || s === "left_without_being_seen") return "danger";
  if (s === "closed") return "success";
  if (s === "in_progress" || s === "in_queue") return "brand";
  return "neutral";
}

/** Only the edges §14 actually allows. See the header. */
function nextActions(status: EncounterStatus): { label: string; action: string }[] {
  switch (status) {
    case "arrived":
      return [{ label: "Add to queue", action: "queue" }];
    case "in_queue":
      return [{ label: "Left without being seen", action: "left" }];
    default:
      return [];
  }
}

const PAYMENT_METHODS = ["cash", "card", "upi", "netbanking"] as const;

/**
 * The bill AND the till for one visit — what the desk owes, and taking the money for it.
 *
 * ── ONE BILL PER BATCH ──────────────────────────────────────────────────────
 * A visit is billed in batches: the consultation at registration, the tests once a doctor has
 * ordered them, the pharmacy after. Each batch is its own numbered document. So this panel has a
 * PENDING section — charges not yet on any bill, with one button to issue them — and then a row per
 * BILL, each with its own payment state and collect box. Finalizing a batch never disturbs a bill
 * already issued (STATE_MACHINE_CATALOG §4).
 *
 * ── FINALIZE ≠ PAY ──────────────────────────────────────────────────────────
 * Issuing a bill freezes its lines and gives it a number; it does NOT take a rupee. Payment is a
 * second, separate act (and permission — money crossing the counter). That separation is what makes
 * the lab's pay-before-run check meaningful: a test runs once ITS bill is paid.
 */
function BillPanel({ encounterId }: { encounterId: string }) {
  const { api, can } = useAuth();
  const [billing, setBilling] = useState<EncounterBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api
      .getEncounterBilling(encounterId)
      .then(setBilling)
      .catch((err: unknown) =>
        setError(err instanceof ApiClientError ? err.message : "Could not load the bill."),
      );
  }, [api, encounterId]);

  useEffect(load, [load]);

  async function finalize() {
    setBusy(true);
    setError(null);
    try {
      await api.finalizeBill(encounterId);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not issue the bill.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !billing) return <p className="text-xs text-[var(--color-danger)]">{error}</p>;
  if (!billing) return <p className="text-xs text-[var(--color-fg-subtle)]">Loading bill…</p>;
  if (billing.pending.total === 0 && billing.invoices.length === 0) {
    return <p className="text-xs text-[var(--color-fg-subtle)]">Nothing charged yet.</p>;
  }

  const pending = billing.pending;

  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}

      {/* PENDING — charges not yet on any bill. One button issues them as a new bill. */}
      {pending.lines.length > 0 && (
        <div className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning-bg)] p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold tracking-wide text-[var(--color-warning)] uppercase">
              Pending — not yet billed
            </span>
            <span className="text-sm font-semibold text-[var(--color-fg)]">
              {rupees(pending.total)}
            </span>
          </div>
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-[var(--color-border)]/50">
              {pending.lines.map((l, i) => (
                <tr key={`${l.code}-${String(i)}`}>
                  <td className="py-1 pr-3 text-[var(--color-fg)]">{l.description}</td>
                  <td className="py-1 pr-3 text-right text-[var(--color-fg-muted)]">
                    {l.quantity > 1 ? `× ${String(l.quantity)}` : ""}
                  </td>
                  <td className="py-1 text-right font-medium text-[var(--color-fg)]">
                    {rupees(l.amount)}
                    {l.amount === 0 && l.listPrice > 0 && (
                      <span className="ml-1 font-normal text-[var(--color-fg-subtle)] line-through">
                        {rupees(l.listPrice)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex justify-end">
            <PermissionGate can={can} permission="billing:finalize">
              <Button variant="secondary" disabled={busy} onClick={() => void finalize()}>
                Issue bill for these
              </Button>
            </PermissionGate>
          </div>
        </div>
      )}

      {/* One row per BILL, each with its own payment state and collect box. */}
      {billing.invoices.map((inv) => (
        <InvoiceRow key={inv.id} invoice={inv} onPaid={load} />
      ))}

      {/* The visit's running totals across every bill. */}
      {billing.invoices.length > 0 && (
        <div className="flex items-center justify-between border-t border-[var(--color-border-strong)] pt-2 text-sm">
          <span className="font-semibold text-[var(--color-fg)]">Visit total</span>
          <span className="text-[var(--color-fg-muted)]">
            {rupees(billing.totalPaid)} paid of {rupees(billing.grandTotal)}
            {billing.outstanding > 0 && (
              <span className="ml-1 font-semibold text-[var(--color-warning)]">
                · {rupees(billing.outstanding)} due
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** One issued bill and its till — the collect box is prefilled to this bill's outstanding balance. */
function InvoiceRow({ invoice, onPaid }: { invoice: Invoice; onPaid: () => void }) {
  const { api, can } = useAuth();
  const outstanding = Math.max(0, invoice.total - invoice.paid);
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when this bill's balance changes (a payment landed) so the box always shows what is left.
  useEffect(() => {
    setAmount((outstanding / 100).toFixed(2));
  }, [outstanding]);

  async function collect() {
    const paise = toPaise(amount);
    if (paise <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (paise > outstanding) {
      setError(`That is more than the ${rupees(outstanding)} outstanding.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.recordPayment(invoice.id, { amount: paise, method });
      onPaid();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
      <div className="flex items-center justify-between">
        <Badge tone={invoice.status === "paid" ? "success" : "brand"}>
          {invoice.number ?? "issued"} · {invoice.status}
        </Badge>
        <span className="text-xs text-[var(--color-fg-muted)]">
          {rupees(invoice.paid)} / {rupees(invoice.total)}
        </span>
      </div>

      {error && <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}

      {outstanding > 0 ? (
        <PermissionGate can={can} permission="payment:collect">
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5 text-[10px] text-[var(--color-fg-muted)]">
              Amount (₹)
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-28 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[10px] text-[var(--color-fg-muted)]">
              Method
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as (typeof PAYMENT_METHODS)[number])}
                className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m === "netbanking" ? "Net banking" : m.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={busy} onClick={() => void collect()}>
              {busy ? "Saving…" : "Record payment"}
            </Button>
          </div>
        </PermissionGate>
      ) : (
        <p className="mt-1 text-xs text-[var(--color-success)]">Paid in full.</p>
      )}
    </div>
  );
}

function Reception() {
  const { api, can } = useAuth();

  const [day, setDay] = useState(todayInput());
  const [register, setRegister] = useState<Encounter[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);

  const [patientId, setPatientId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [reason, setReason] = useState("");
  // A paid fast-track visit: the patient is seen ahead of the normal queue and pays an express
  // surcharge on top of the consultation. Off by default — the ordinary visit is the common one.
  const [express, setExpress] = useState(false);

  const [openBill, setOpenBill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The DOCTORS DIRECTORY, not the staff list. A receptionist has `encounter:read`
    // and not `user:read` — asking for the personnel file 403s and leaves the picker
    // empty, which is exactly the bug this replaced.
    void api
      .listDoctors()
      .then(setDoctors)
      .catch(() => setError("Could not load doctors."));

    /**
     * 100 is the server's cap. Asking for more is a 400, not a bigger page.
     *
     * The failure is SURFACED rather than swallowed: an earlier `.catch(() => undefined)`
     * here turned that 400 into an empty dropdown with no error, which reads as "this
     * hospital has no patients" — a lie that took a browser session to disbelieve.
     */
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
      const page = await api.listEncounters({ date: day, limit: 100 });
      setRegister(page.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the register.");
    } finally {
      setLoading(false);
    }
  }, [api, day]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A patient walks in.
   *
   * `resumed: true` is the interesting case and is NOT an error: the patient is
   * already here — usually back from the lab — and the clerk gets their existing
   * visit and token. Saying "already in the queue, token 12" is the answer they
   * wanted; an error is what makes them create a duplicate patient record instead.
   */
  async function startVisit() {
    if (!patientId) {
      setError("Choose a patient first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await api.startEncounter({
        patientId,
        ...(doctorId ? { doctorId, departmentId: doctorId } : {}),
        ...(reason ? { reason } : {}),
        ...(express ? { express: true } : {}),
      });

      const who = patients.find((p) => p.id === patientId)?.name ?? "Patient";
      const token = result.encounter.token;
      const fast = result.encounter.express ? " · Express (fast-track)" : "";

      setNotice(
        result.resumed
          ? `${who} is already here — ${token ? `token ${String(token)}` : "visit open"}. Resumed their existing visit.`
          : `${who} registered${token ? ` — token ${String(token)}` : ""}${fast}. The consultation fee is on their bill${express ? " with the express surcharge" : ""}.`,
      );
      setReason("");
      setPatientId("");
      setExpress(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not start the visit.");
    } finally {
      setBusy(false);
    }
  }

  async function act(encounter: Encounter, action: string) {
    setBusy(true);
    setError(null);
    try {
      if (action === "queue") await api.queueEncounter(encounter.id);
      if (action === "left") {
        // A reason is not required by the API here, but the distinction from
        // "cancelled" is: a rising LWBS count is a queue that is too slow.
        await api.markLeftWithoutBeingSeen(encounter.id);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the visit.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";
  const doctorOf = (id?: string): string =>
    id ? (doctors.find((d) => d.id === id)?.name ?? "—") : "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Reception</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Register a patient who has walked in, and see everyone who came today.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {/* ── the walk-in desk ── */}
      <PermissionGate can={can} permission="encounter:create">
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">
            A patient has arrived
          </h2>
          <p className="mb-4 text-xs text-[var(--color-fg-muted)]">
            No appointment needed. Whether they get a token now or at check-in is this
            hospital&apos;s policy, not a choice on this screen.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Patient
              </span>
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
              >
                <option value="">Choose a patient…</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.uhid}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Doctor / department
              </span>
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
              >
                <option value="">Choose…</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Reason (optional)
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Fever, follow-up…"
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)] outline-none"
              />
            </label>
          </div>

          {/* Normal vs paid fast-track. Express is a deliberate, priced choice — the patient is
              seen ahead of the queue and pays a surcharge — so it is two plain buttons, not a
              checkbox that could be ticked by accident. */}
          <div className="mt-4">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
              Visit type
            </span>
            <div className="inline-flex rounded-lg border border-[var(--color-border-strong)] p-0.5">
              <button
                type="button"
                onClick={() => setExpress(false)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  !express
                    ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                }`}
              >
                Normal
              </button>
              <button
                type="button"
                onClick={() => setExpress(true)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  express
                    ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                }`}
              >
                Express (fast-track)
              </button>
            </div>
            {express && (
              <p className="mt-1.5 text-xs text-[var(--color-warning)]">
                Seen ahead of the queue. An express surcharge is added to the consultation fee.
              </p>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button disabled={busy || !patientId} onClick={() => void startVisit()}>
              {busy ? "Registering…" : "Register arrival"}
            </Button>
            <a
              href="/patients"
              className="text-sm text-[var(--color-brand-700)] underline underline-offset-2"
            >
              New patient? Register them first
            </a>
          </div>
        </Card>
      </PermissionGate>

      {/* ── the day's register ── */}
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Who came in</h2>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
              {register.length} {register.length === 1 ? "visit" : "visits"}
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
              Day
            </span>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
          </label>
        </div>

        {loading ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
        ) : register.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            Nobody has come in on this day.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-subtle)] uppercase">
                <tr>
                  <th className="py-2 pr-4">Token</th>
                  <th className="py-2 pr-4">Arrived</th>
                  <th className="py-2 pr-4">Patient</th>
                  <th className="py-2 pr-4">Doctor</th>
                  <th className="py-2 pr-4">Origin</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {register.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="py-2.5 pr-4">
                        {e.token ? (
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-brand-50)] font-mono text-sm font-semibold text-[var(--color-brand-700)]">
                            {e.token}
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-fg-muted)]">
                        {time(e.arrivedAt)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="text-[var(--color-fg)]">{nameOf(e.patientId)}</span>{" "}
                        <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                          {uhidOf(e.patientId)}
                        </span>
                        {e.express && (
                          <span className="ml-2 rounded-full bg-[var(--color-warning-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-warning)] uppercase">
                            Express
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-fg-muted)]">
                        {doctorOf(e.doctorId ?? e.departmentId)}
                      </td>
                      <td className="py-2.5 pr-4">
                        {/* A walk-in and a booked patient are the same thing once they
                            are in the building — but WHICH they were is worth seeing. */}
                        <span className="text-xs text-[var(--color-fg-muted)]">
                          {e.origin.replace("_", " ")}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge tone={statusTone(e.status)}>{e.status.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          {can("encounter:update") &&
                            nextActions(e.status).map((next) => (
                              <Button
                                key={next.action}
                                variant="secondary"
                                disabled={busy}
                                onClick={() => void act(e, next.action)}
                              >
                                {next.label}
                              </Button>
                            ))}
                          <PermissionGate can={can} permission="billing:read">
                            <Button
                              variant="ghost"
                              onClick={() => setOpenBill(openBill === e.id ? null : e.id)}
                            >
                              {openBill === e.id ? "Hide bill" : "Bill"}
                            </Button>
                          </PermissionGate>
                          {/* The take-home OPD slip — opens as a clean printable sheet. */}
                          <a
                            href={`/opd-slip/${e.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-lg px-2 py-1 text-sm text-[var(--color-brand-700)] hover:underline"
                          >
                            OPD slip ↗
                          </a>
                        </div>
                      </td>
                    </tr>
                    {openBill === e.id && (
                      <tr>
                        <td colSpan={7} className="pb-3">
                          <BillPanel encounterId={e.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function ReceptionPage() {
  return (
    <Protected>
      <Reception />
    </Protected>
  );
}
