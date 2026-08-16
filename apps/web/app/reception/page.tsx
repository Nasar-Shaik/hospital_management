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
  type VitalsReading,
} from "@medicore/api-client";
import { rupees, toPaise } from "../../lib/money";
import { idempotencyMessage, useIdempotencyKey } from "../../lib/idempotency";
import { useAuth } from "../../components/AuthProvider";
import { VitalsPanel } from "../../components/Vitals";
import { useBranch } from "../../components/BranchProvider";
import { dayKeyInZone, todayInZone } from "../../lib/day";
import { Alert, Badge, Button, Card, ErrorAlert, PermissionGate } from "../../components/ui";

/** A friendly "12 Jul" for telling a clerk which day a resumed visit lives on. */
function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
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

/**
 * Only the edges §14 actually allows. See the header.
 *
 * `arrived → in_queue` ("Add to queue") is deliberately NOT here: it is gated on the OP fee being
 * paid and is rendered separately below, so an unpaid walk-in is never offered the queue button.
 */
function nextActions(status: EncounterStatus): { label: string; action: string }[] {
  switch (status) {
    case "in_queue":
      return [{ label: "Left without being seen", action: "left" }];
    default:
      return [];
  }
}

/** OP-fee status per encounter — the reception pay-before-queue gate. */
type ConsultPayState = "paid" | "unpaid" | "unbilled" | "free";

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
/**
 * Height, weight, BP and temperature, taken at the desk.
 *
 * ── WHY THE FRONT DESK MEASURES AT ALL ──────────────────────────────────────
 * "While registering patient we need to enter basic details like height, weight, from this 2 we
 * need to calculate BMI on op slip and temp, BP … so that those are available in doctor login
 * patient details so that doctor will get to know more about patient."
 *
 * Until now `vitals:record` was held by NURSE alone, and there is no nurse at the front door — so
 * in practice nothing was measured before the consultation at all. In an Indian OPD the weighing
 * scale is beside the counter; this is that reality, granted deliberately (see the RECEPTIONIST
 * role, which explains the decision and its limits).
 *
 * It reuses the ward's `VitalsPanel` rather than growing a second form: that component already
 * carries the idempotency key that stops a double-click charting twice, and the reconciliation
 * that resolves "did my save land?" against the chart instead of guessing. A simpler desk form
 * would be a second answer to both questions.
 *
 * BMI is not entered — the API derives it, and only when height and weight are on the SAME
 * reading, so a height carried forward from an old visit can never be paired with today's weight.
 */
function VitalsRowPanel({ encounterId }: { encounterId: string }) {
  const { api, can, user } = useAuth();
  const [readings, setReadings] = useState<VitalsReading[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listEncounterVitals(encounterId)
      .then(setReadings)
      // Advisory: a desk that cannot READ them can still take them, and says so rather than
      // showing an empty chart that reads as "nothing was measured".
      .catch(() => setError("Could not load this visit's observations."));
  }, [api, encounterId]);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      {error && <p className="mb-2 text-xs text-[var(--color-danger)]">{error}</p>}
      <VitalsPanel
        api={api}
        encounterId={encounterId}
        readings={readings}
        canRecord={can("vitals:record")}
        onSaved={(r) => setReadings((prev) => [...prev, r])}
        emptyHint="Nothing measured yet. Height and weight give the doctor a BMI; BP and temperature travel with the visit."
        {...(user?.id ? { recordedBy: user.id } : {})}
      />
    </div>
  );
}

function BillPanel({ encounterId, onChange }: { encounterId: string; onChange?: () => void }) {
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
      // The register's payment gate reads from billing too — keep it in step.
      onChange?.();
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
        <InvoiceRow
          key={inv.id}
          invoice={inv}
          onPaid={() => {
            load();
            onChange?.();
          }}
        />
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
  const [requestId, renewRequestId] = useIdempotencyKey();

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
      // Header + body, same string — see the note in `lib/idempotency.ts`.
      await api.recordPayment(invoice.id, { amount: paise, method, requestId }, requestId);
      // A part-payment leaves the form open for the rest, which is a NEW intent.
      renewRequestId();
      onPaid();
    } catch (err) {
      setError(
        idempotencyMessage(err) ??
          (err instanceof ApiClientError ? err.message : "Could not record the payment."),
      );
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
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-fg-muted)]">
            {rupees(invoice.paid)} / {rupees(invoice.total)}
          </span>
          {/* The printable money receipt for THIS bill — the OP / tests / pharmacy receipt. Opens in
              the SAME tab: the print pages need the signed-in session, and in dev that session is
              per-tab (sessionStorage), so a new tab would open without one. The receipt has its own
              "← Back" button. */}
          <a
            href={`/receipt/${invoice.id}`}
            className="text-xs text-[var(--color-brand-700)] hover:underline"
          >
            Receipt →
          </a>
        </div>
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
  // The desk's day. The server resolves it in the HOSPITAL's zone, so the picker must agree.
  const { timezone } = useBranch();

  const [day, setDay] = useState(() => todayInZone(timezone));
  const [register, setRegister] = useState<Encounter[]>([]);
  // OP-fee status per encounter, for the pay-before-queue gate. Empty until the register loads.
  const [consultPaid, setConsultPaid] = useState<Record<string, ConsultPayState>>({});
  const [patients, setPatients] = useState<Patient[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);

  const [patientId, setPatientId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [reason, setReason] = useState("");
  // A paid fast-track visit: the patient is seen ahead of the normal queue and pays an express
  // surcharge on top of the consultation. Off by default — the ordinary visit is the common one.
  const [express, setExpress] = useState(false);

  const [openBill, setOpenBill] = useState<string | null>(null);
  const [openVitals, setOpenVitals] = useState<string | null>(null);
  // Holds the raw thrown value, so ErrorAlert can surface its trace reference for support.
  const [error, setError] = useState<unknown>(null);
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
      .catch((err: unknown) => setError(err));
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listEncounters({ date: day, limit: 100 });
      setRegister(page.items);
      // The pay-before-queue gate reads the consultation's payment state. One call for the day;
      // a failure here must not blank the register, so it degrades to "unknown" (gate stays shut).
      const status = await api
        .consultationPaymentStatus(page.items.map((e) => e.id))
        .catch(() => ({}) as Record<string, ConsultPayState>);
      setConsultPaid(status);
      setError(null);
    } catch (err) {
      setError(err);
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
      const tokenLabel = token ? `token ${String(token)}` : "visit open";

      // A resumed visit may have arrived on an EARLIER day (a visit left open, e.g. patient
      // still mid-treatment). If so, the day-filtered register below would show nothing for
      // today and the clerk would rightly ask "where did they go?". Jump the register to the
      // day the visit actually lives on, so the patient appears in the list right away.
      const arrivedDay = dayKeyInZone(new Date(result.encounter.arrivedAt), timezone);
      const onAnotherDay = result.resumed && arrivedDay !== day;

      setReason("");
      setPatientId("");
      setExpress(false);

      if (result.resumed) {
        setNotice(
          onAnotherDay
            ? `${who} already has a visit open from ${dayLabel(result.encounter.arrivedAt)} — ${tokenLabel}. Showing that day so you can find them.`
            : `${who} is already here — ${tokenLabel}. Resumed their existing visit.`,
        );
      } else {
        setNotice(
          `${who} registered${token ? ` — token ${String(token)}` : ""}${fast}. The consultation fee is on their bill${express ? " with the express surcharge" : ""}.`,
        );
      }

      // Switching the day re-runs the register load via its effect; otherwise reload this day.
      if (onAnotherDay) setDay(arrivedDay);
      else await load();
    } catch (err) {
      setError(err);
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
      setError(err);
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
        {/**
         * The counterpart of the note on Appointments. Both screens create the SAME thing — an
         * encounter in the doctor's queue — and differ only in whether the patient booked ahead
         * (`origin: "walk_in"` vs `"appointment"`, ADR-0013). Naming the other door here is what
         * stops the two reading as competing ways to do one job.
         */}
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Walked in today — register them and put them in a doctor&apos;s queue. A patient who
          booked ahead is checked in from{" "}
          <a href="/appointments" className="underline underline-offset-2">
            Appointments
          </a>{" "}
          instead, and lands in the same queue.
        </p>
      </div>

      {error != null && <ErrorAlert error={error} fallback="Something went wrong." />}
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
          <div className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            <p>Nobody has come in on this day.</p>
            <p className="mt-1 text-xs">
              Looking for someone mid-visit from another day? Find them on the{" "}
              <a
                href="/patients"
                className="text-[var(--color-brand-700)] underline underline-offset-2"
              >
                Patients
              </a>{" "}
              page.
            </p>
          </div>
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* PAY BEFORE QUEUE: a walked-in patient joins the doctor's queue only
                              once the OP fee is settled (or is free — a zero-tariff patient). Until
                              then the queue button is not drawn; instead the desk is told to take the
                              fee, or — if this login cannot take money — to send them to the counter. */}
                          {e.status === "arrived" &&
                            can("encounter:update") &&
                            (consultPaid[e.id] === "paid" || consultPaid[e.id] === "free" ? (
                              <>
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => void act(e, "queue")}
                                >
                                  Add to queue
                                </Button>
                                {/* A ₹0 consultation — a free follow-up inside the tariff's OP
                                    validity, or a zero-tariff patient. Said out loud so the desk
                                    knows the fee was WAIVED, not forgotten. The bill panel names
                                    which, on the charge line itself. */}
                                {consultPaid[e.id] === "free" && (
                                  <span className="rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">
                                    No fee
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="rounded-full bg-[var(--color-warning-bg)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-warning)] uppercase">
                                  OP fee due
                                </span>
                                {can("payment:collect") ? (
                                  <Button
                                    variant="secondary"
                                    onClick={() => setOpenBill(openBill === e.id ? null : e.id)}
                                  >
                                    {openBill === e.id ? "Hide bill" : "Collect OP fee"}
                                  </Button>
                                ) : (
                                  <span className="text-xs text-[var(--color-fg-subtle)]">
                                    Collect at cash counter
                                  </span>
                                )}
                              </span>
                            ))}

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
                          <PermissionGate can={can} permission="vitals:record">
                            <Button
                              variant="ghost"
                              onClick={() => setOpenVitals(openVitals === e.id ? null : e.id)}
                            >
                              {openVitals === e.id ? "Hide vitals" : "Vitals"}
                            </Button>
                          </PermissionGate>
                          <PermissionGate can={can} permission="billing:read">
                            <Button
                              variant="ghost"
                              onClick={() => setOpenBill(openBill === e.id ? null : e.id)}
                            >
                              {openBill === e.id ? "Hide bill" : "Bill"}
                            </Button>
                          </PermissionGate>
                          {/* The take-home OPD slip — a clean printable sheet. Same tab, so the
                              signed-in (per-tab, in dev) session is present; it has its own Back button. */}
                          <a
                            href={`/opd-slip/${e.id}`}
                            className="inline-flex items-center rounded-lg px-2 py-1 text-sm text-[var(--color-brand-700)] hover:underline"
                          >
                            OPD slip →
                          </a>
                        </div>
                      </td>
                    </tr>
                    {openVitals === e.id && (
                      <tr>
                        <td colSpan={7} className="pb-3">
                          <VitalsRowPanel encounterId={e.id} />
                        </td>
                      </tr>
                    )}
                    {openBill === e.id && (
                      <tr>
                        <td colSpan={7} className="pb-3">
                          <BillPanel encounterId={e.id} onChange={() => void load()} />
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
  return <Reception />;
}
