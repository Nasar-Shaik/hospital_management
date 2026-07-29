"use client";

/**
 * Billing (Doc 02 F-group) — the counter.
 *
 * ── THE SAME SCREEN SERVES A PRIVATE AND A GOVERNMENT HOSPITAL ───────────────
 * At Sunrise it shows ₹1,300 and takes the money. At District General every line is
 * ₹0 and the bill is already `paid` the moment it is issued. Same code, same columns,
 * same invoice number — the difference is `billingMode` on the hospital's preset, and
 * nothing on this page knows which kind of hospital it is running in.
 *
 * A government bill is NOT an empty screen. It has real line items with real list
 * prices struck through, because free to the PATIENT is not free to the STATE — and
 * the numbers the state needs to cost the care are exactly these.
 *
 * ── EVERY AMOUNT IS PAISE UNTIL IT IS PRINTED ────────────────────────────────
 * `rupees()` at the edge, nothing computed on the divided number (lib/money.ts).
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  type Invoice,
  type InvoiceStatus,
  type InsurancePolicy,
  type Patient,
} from "@medicore/api-client";
import { rupees, toPaise } from "../../lib/money";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";

const METHODS = ["cash", "card", "upi", "netbanking", "cheque", "insurance"] as const;

function statusTone(s: InvoiceStatus): "success" | "danger" | "brand" | "neutral" {
  if (s === "paid") return "success";
  if (s === "cancelled") return "danger";
  if (s === "finalized") return "brand";
  return "neutral";
}

/** Payments the patient made themselves — everything except the insurer's `insurance`-method money. */
function patientPaidOf(invoice: Invoice): number {
  return invoice.payments.filter((p) => p.method !== "insurance").reduce((s, p) => s + p.amount, 0);
}

/** Taking money. Partial payments are normal; the server refuses an overpayment. */
function PaymentForm({ invoice, onPaid }: { invoice: Invoice; onPaid: () => void }) {
  const { api } = useAuth();
  const balance = invoice.total - invoice.paid;
  // With a payer split, the counter collects the PATIENT'S share, not the whole balance — the
  // insurer's part arrives separately (method `insurance`). Default to whichever the counter owes.
  const patientOwes = Math.max(0, invoice.patientResponsibility - patientPaidOf(invoice));
  const defaultAmount = invoice.coveredByInsurer > 0 ? patientOwes : balance;

  // Pre-filled with what is owed, because that is what is paid nine times in ten —
  // and typing an amount is the one place a human can put money in the wrong column.
  const [amount, setAmount] = useState((defaultAmount / 100).toFixed(2));
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.recordPayment(invoice.id, {
        amount: toPaise(amount),
        method,
        ...(reference ? { reference } : {}),
      });
      onPaid();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.5fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Amount (₹)
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Method
          </span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Reference (optional)
          </span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UPI / card ref"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>

        <div className="flex items-end">
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Taking…" : "Take payment"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-[var(--color-fg-subtle)]">
        Balance {rupees(balance)}. A part payment is fine — the bill stays open.
      </p>
    </div>
  );
}

/** An approved write-down on a finalized bill. A reason is mandatory — a discount without one is a leak. */
function DiscountForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const { api } = useAuth();
  const headroom = invoice.subtotal - invoice.paid;
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.applyDiscount(invoice.id, { amount: toPaise(amount), reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not apply the discount.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Discount (₹)
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Reason (recorded)
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. management concession, camp rate"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <div className="flex items-end">
          <Button
            disabled={busy || !amount.trim() || reason.trim().length < 3}
            onClick={() => void submit()}
          >
            {busy ? "Applying…" : "Apply discount"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        Reduces the bill of {rupees(invoice.subtotal)}; cannot drop below the {rupees(invoice.paid)}{" "}
        already paid ({rupees(headroom)} of room).
      </p>
    </div>
  );
}

/** Hands money back. Never more than net collected; a reason is mandatory. */
function RefundForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const { api } = useAuth();
  const net = invoice.paid - invoice.refunded;
  const [amount, setAmount] = useState((net / 100).toFixed(2));
  const [method, setMethod] = useState<string>("cash");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.recordRefund(invoice.id, { amount: toPaise(amount), method, reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not record the refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Refund (₹)
          </span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Method
          </span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
            Reason (recorded)
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. overpayment, cancelled test"
            className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
          />
        </label>
        <div className="flex items-end">
          <Button
            variant="danger"
            disabled={busy || !amount.trim() || reason.trim().length < 3}
            onClick={() => void submit()}
          >
            {busy ? "Refunding…" : "Refund"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        {rupees(net)} available to refund (collected less what was already returned).
      </p>
    </div>
  );
}

/** Assigns an insurer share to the bill — the patient then owes only the rest. */
function PayerSplitForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const { api } = useAuth();
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [policyId, setPolicyId] = useState(invoice.insurerPolicyId ?? "");
  const [covered, setCovered] = useState(
    invoice.coveredByInsurer > 0 ? (invoice.coveredByInsurer / 100).toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listInsurancePolicies(invoice.patientId)
      .then((p) => {
        setPolicies(p);
        setPolicyId((cur) => cur || p[0]?.id || "");
      })
      .catch(() => setPolicies([]));
  }, [api, invoice.patientId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.setPayerSplit(invoice.id, { policyId, coveredAmount: toPaise(covered) });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not set the payer split.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {policies.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">
          This patient has no insurance policy on record. Add one on their profile first.
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                Insurer policy
              </span>
              <select
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
                className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              >
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.insurer} · {p.policyNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                Insurer covers (₹)
              </span>
              <input
                value={covered}
                onChange={(e) => setCovered(e.target.value)}
                inputMode="decimal"
                className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
              />
            </label>
            <div className="flex items-end">
              <Button disabled={busy || !policyId || !covered.trim()} onClick={() => void submit()}>
                {busy ? "Saving…" : "Set split"}
              </Button>
            </div>
          </div>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            Of the {rupees(invoice.total)} bill, the patient then owes the balance. The
            insurer&apos;s share is collected separately (method “insurance”) and recovered by a
            claim.
          </p>
        </>
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  nameOf,
  onChanged,
}: {
  invoice: Invoice;
  nameOf: (id: string) => string;
  onChanged: () => void;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [splitting, setSplitting] = useState(false);

  const owes = invoice.total - invoice.paid;
  const net = invoice.paid - invoice.refunded;
  const patientOwes = Math.max(0, invoice.patientResponsibility - patientPaidOf(invoice));

  return (
    <li className="rounded-lg border border-[var(--color-border)] p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-[var(--color-fg)]">
              {invoice.number ?? "draft"}
            </span>
            <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
            {/*
             * A ₹0 bill at a government hospital is `paid` on issue — it must never sit
             * in an "outstanding" list that nobody will ever clear.
             */}
            {invoice.total === 0 && <Badge tone="neutral">no charge</Badge>}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{nameOf(invoice.patientId)}</p>
        </div>

        <div className="text-right">
          <p className="text-lg font-semibold text-[var(--color-fg)]">{rupees(invoice.total)}</p>
          {invoice.discount > 0 && (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              after {rupees(invoice.discount)} discount
            </p>
          )}
          {invoice.coveredByInsurer > 0 && (
            <p className="text-xs text-[var(--color-brand)]">
              insurer {rupees(invoice.coveredByInsurer)} · patient{" "}
              {rupees(invoice.patientResponsibility)}
            </p>
          )}
          {invoice.coveredByInsurer > 0 && patientOwes > 0 ? (
            <p className="text-xs text-[var(--color-danger)]">{rupees(patientOwes)} patient owes</p>
          ) : (
            owes > 0 && (
              <p className="text-xs text-[var(--color-danger)]">{rupees(owes)} outstanding</p>
            )
          )}
          {invoice.paid > 0 && invoice.paid < invoice.total && (
            <p className="text-xs text-[var(--color-fg-subtle)]">{rupees(invoice.paid)} paid</p>
          )}
          {invoice.refunded > 0 && (
            <p className="text-xs text-[var(--color-warning)]">
              {rupees(invoice.refunded)} refunded
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Hide lines" : "View lines"}
        </Button>
        {owes > 0 && invoice.status === "finalized" && (
          <PermissionGate can={can} permission="payment:collect">
            <Button variant="secondary" onClick={() => setPaying(!paying)}>
              {paying ? "Cancel" : "Take payment"}
            </Button>
          </PermissionGate>
        )}
        {owes > 0 && invoice.status === "finalized" && (
          <PermissionGate can={can} permission="billing:discount">
            <Button variant="ghost" onClick={() => setDiscounting(!discounting)}>
              {discounting ? "Cancel" : "Discount"}
            </Button>
          </PermissionGate>
        )}
        {net > 0 && (
          <PermissionGate can={can} permission="billing:refund">
            <Button variant="ghost" onClick={() => setRefunding(!refunding)}>
              {refunding ? "Cancel" : "Refund"}
            </Button>
          </PermissionGate>
        )}
        {invoice.status === "finalized" && (
          <PermissionGate can={can} permission="insurance:link">
            <Button variant="ghost" onClick={() => setSplitting(!splitting)}>
              {splitting
                ? "Cancel"
                : invoice.coveredByInsurer > 0
                  ? "Edit payer split"
                  : "Payer split"}
            </Button>
          </PermissionGate>
        )}
      </div>

      {open && (
        <table className="mt-3 w-full text-left text-xs">
          <tbody className="divide-y divide-[var(--color-border)]">
            {invoice.lines.map((l, i) => (
              <tr key={`${l.code}-${String(i)}`}>
                <td className="py-1.5 pr-3 text-[var(--color-fg)]">{l.description}</td>
                <td className="py-1.5 pr-3 text-[var(--color-fg-subtle)]">{l.category}</td>
                <td className="py-1.5 text-right font-medium text-[var(--color-fg)]">
                  {rupees(l.amount)}
                  {l.amount === 0 && l.listPrice > 0 && (
                    <span
                      title="What this care is worth. The patient pays nothing; the state still costs it."
                      className="ml-1 font-normal text-[var(--color-fg-subtle)] line-through"
                    >
                      {rupees(l.listPrice)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {invoice.discount > 0 && invoice.discountReason && (
        <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
          Discount {rupees(invoice.discount)} — {invoice.discountReason}
        </p>
      )}

      {invoice.payments.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {invoice.payments.map((p, i) => (
            <li key={i} className="text-xs text-[var(--color-fg-subtle)]">
              {rupees(p.amount)} · {p.method}
              {p.reference ? ` · ${p.reference}` : ""} ·{" "}
              {new Date(p.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </li>
          ))}
        </ul>
      )}

      {invoice.refunds.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {invoice.refunds.map((r, i) => (
            <li key={i} className="text-xs text-[var(--color-warning)]">
              −{rupees(r.amount)} refund · {r.method} · {r.reason} ·{" "}
              {new Date(r.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </li>
          ))}
        </ul>
      )}

      {paying && (
        <PaymentForm
          invoice={invoice}
          onPaid={() => {
            setPaying(false);
            onChanged();
          }}
        />
      )}
      {discounting && (
        <DiscountForm
          invoice={invoice}
          onDone={() => {
            setDiscounting(false);
            onChanged();
          }}
        />
      )}
      {refunding && (
        <RefundForm
          invoice={invoice}
          onDone={() => {
            setRefunding(false);
            onChanged();
          }}
        />
      )}
      {splitting && (
        <PayerSplitForm
          invoice={invoice}
          onDone={() => {
            setSplitting(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function Billing() {
  const { api } = useAuth();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [filter, setFilter] = useState<InvoiceStatus | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
      const page = await api.listInvoices({
        limit: 100,
        ...(filter !== "all" ? { status: filter } : {}),
      });
      setInvoices(page.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load bills.");
    } finally {
      setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";

  const outstanding = invoices.reduce((sum, i) => sum + (i.total - i.paid), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Billing</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Bills are issued from the visit — Reception finalizes them. This is the counter.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["all", "finalized", "paid", "cancelled"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f
                  ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                  : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
              }`}
            >
              {f === "finalized" ? "unpaid" : f}
            </button>
          ))}
        </div>

        {outstanding > 0 && (
          <p className="text-sm text-[var(--color-fg-muted)]">
            <span className="font-semibold text-[var(--color-fg)]">{rupees(outstanding)}</span>{" "}
            outstanding
          </p>
        )}
      </div>

      <Card className="p-5">
        {loading ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            No bills yet. A bill appears once Reception finalizes a visit.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {invoices.map((i) => (
              <InvoiceRow key={i.id} invoice={i} nameOf={nameOf} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function BillingPage() {
  return <Billing />;
}
