"use client";

/**
 * The payment receipt — the money proof a patient is handed at the counter.
 *
 * ── ONE RECEIPT, USED EVERYWHERE ─────────────────────────────────────────────
 * Every payment point in the visit — the OP fee, the tests, the pharmacy — is just a PAID
 * (or part-paid) bill, so all three receipts are this one page, keyed on the invoice id. It is
 * rendered OUTSIDE the app shell so `window.print()` yields a clean slip, and every value is
 * composed from the invoice that already exists: its number is the receipt number, its lines are
 * the items, its payments are the money actually taken. Nothing here is fabricated.
 *
 * This is DELIBERATELY separate from the OPD slip: that sheet is the clinical take-home (diagnosis,
 * Rx, advice); this one is the financial record of a single payment. Two documents, two jobs.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { ApiClientError, type Invoice, type Patient, type PublicSite } from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { rupees } from "../../../lib/money";

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Stored payment methods → what a patient reads on paper. */
function methodLabel(method: string): string {
  switch (method) {
    case "wallet":
      return "From advance";
    case "netbanking":
      return "Net banking";
    case "upi":
      return "UPI";
    default:
      return method.charAt(0).toUpperCase() + method.slice(1);
  }
}

function Receipt() {
  const { api, user, loading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [site, setSite] = useState<PublicSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

      const inv = await api.getInvoice(id);
      setInvoice(inv);

      const [pat, theSite] = await Promise.all([
        soft(api.getPatient(inv.patientId), null as Patient | null),
        soft(api.getPublicSite(), null as PublicSite | null),
      ]);
      setPatient(pat);
      setSite(theSite);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This bill could not be found."
          : "Could not load this receipt.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    // Wait for the session bootstrap to settle before loading — otherwise a hard open (or a dev
    // per-tab tab with no session yet) would read `user` as null and never fetch.
    if (!authLoading && user) void load();
  }, [authLoading, user, load]);

  // Still bootstrapping the session, or fetching the bill — a spinner, not a dead page.
  if (authLoading || (user && loading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
      </div>
    );
  }

  // No session in this browsing context (e.g. the URL was opened cold). Say so plainly instead of
  // spinning forever, and offer the way back in.
  if (!user) {
    return (
      <div className="mx-auto max-w-md p-10 text-center text-gray-600">
        <p className="font-medium text-gray-800">Please sign in to view this receipt.</p>
        <p className="mt-1 text-sm">
          Open it from within MediCore, where you are already signed in.
        </p>
        <div className="mt-4">
          <a href="/login" className="rounded border border-gray-300 px-4 py-2 text-sm">
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="mx-auto max-w-2xl p-10 text-center text-gray-600">
        {error ?? "Not found."}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="rounded border border-gray-300 px-4 py-2 text-sm"
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  const accent = site?.accentColor ?? "#0d9488";
  const hospitalName = site?.displayName ?? site?.hospitalName ?? "Hospital";
  const balance = Math.max(0, invoice.total - invoice.paid);
  const stamp: { label: string; color: string } =
    invoice.paid >= invoice.total && invoice.total > 0
      ? { label: "PAID", color: "#16a34a" }
      : invoice.paid > 0
        ? { label: "PART PAID", color: "#d97706" }
        : { label: "DUE", color: "#dc2626" };
  // The receipt's date is when money last moved; fall back to when the bill was frozen.
  const lastPaymentAt = invoice.payments.at(-1)?.at ?? invoice.finalizedAt;

  return (
    <div className="rcpt-root min-h-screen bg-gray-100 py-8 text-gray-900">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .rcpt-root { background: #fff !important; padding: 0 !important; }
          .rcpt-sheet { box-shadow: none !important; margin: 0 !important; width: 100% !important; }
          @page { margin: 14mm; }
        }
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="no-print mx-auto mb-4 flex max-w-[620px] items-center justify-between px-4">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg px-4 py-1.5 text-sm font-semibold text-white"
          style={{ backgroundColor: accent }}
        >
          Print / Save PDF
        </button>
      </div>

      {/* The slip — narrower than the OPD sheet; a receipt is a half-page document. */}
      <div className="rcpt-sheet mx-auto max-w-[620px] bg-white px-9 py-8 shadow-sm">
        {/* Header */}
        <header
          className="flex items-start justify-between gap-4 border-b-2 pb-4"
          style={{ borderColor: accent }}
        >
          <div>
            <h1 className="text-xl font-bold" style={{ color: accent }}>
              {hospitalName}
            </h1>
            {site?.tagline && <p className="text-xs text-gray-500">{site.tagline}</p>}
            <div className="mt-1 text-[11px] text-gray-600">
              {site?.contact.address && <div>{site.contact.address}</div>}
              <div className="flex gap-3">
                {site?.contact.phone && <span>☎ {site.contact.phone}</span>}
                {site?.contact.email && <span>✉ {site.contact.email}</span>}
              </div>
            </div>
          </div>
          <Seal accent={accent} name={hospitalName} />
        </header>

        {/* Title + receipt no + PAID stamp */}
        <div className="mt-4 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-[0.2em] text-gray-700 uppercase">
              Payment Receipt
            </h2>
            <div className="mt-1 text-xs text-gray-600">
              <div>
                Receipt No:{" "}
                <span className="font-mono font-semibold text-gray-900">
                  {invoice.number ?? invoice.id.slice(-8).toUpperCase()}
                </span>
              </div>
              <div>Date: {fmtDateTime(lastPaymentAt)}</div>
            </div>
          </div>
          <Stamp label={stamp.label} color={stamp.color} />
        </div>

        {/* Patient */}
        <section className="mt-4 rounded-lg bg-gray-50 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-gray-900">{patient?.name ?? "Patient"}</span>
            {patient?.uhid && (
              <span className="font-mono text-xs text-gray-600">{patient.uhid}</span>
            )}
          </div>
          {patient?.contact.phone && (
            <div className="mt-0.5 text-xs text-gray-600">☎ {patient.contact.phone}</div>
          )}
        </section>

        {/* Items */}
        <section className="mt-5">
          <SectionLabel accent={accent}>Items</SectionLabel>
          <table className="mt-1 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                <th className="py-1 font-medium">Description</th>
                <th className="py-1 pr-2 text-right font-medium">Qty</th>
                <th className="py-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((l, i) => (
                <tr key={`${l.code}-${i}`} className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-800">{l.description}</td>
                  <td className="py-1.5 pr-2 text-right text-gray-500">
                    {l.quantity > 1 ? l.quantity : ""}
                  </td>
                  <td className="py-1.5 text-right font-medium text-gray-900">
                    {rupees(l.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="text-sm">
              {invoice.discount > 0 && (
                <tr>
                  <td className="pt-1.5 text-gray-600" colSpan={2}>
                    Discount
                  </td>
                  <td className="pt-1.5 text-right text-gray-700">−{rupees(invoice.discount)}</td>
                </tr>
              )}
              <tr className="border-t-2 border-gray-300">
                <td className="pt-1.5 font-semibold text-gray-900" colSpan={2}>
                  Total
                </td>
                <td className="pt-1.5 text-right font-semibold text-gray-900">
                  {rupees(invoice.total)}
                </td>
              </tr>
              <tr>
                <td className="text-gray-600" colSpan={2}>
                  Paid
                </td>
                <td className="text-right font-medium" style={{ color: stamp.color }}>
                  {rupees(invoice.paid)}
                </td>
              </tr>
              {balance > 0 && (
                <tr>
                  <td className="font-medium text-red-600" colSpan={2}>
                    Balance due
                  </td>
                  <td className="text-right font-medium text-red-600">{rupees(balance)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </section>

        {/* How it was paid — the actual money movements on this bill. */}
        {invoice.payments.length > 0 && (
          <section className="mt-5">
            <SectionLabel accent={accent}>Payments</SectionLabel>
            <ul className="mt-1 space-y-1 text-sm">
              {invoice.payments.map((p, i) => (
                <li key={i} className="flex items-center justify-between text-gray-700">
                  <span>
                    {methodLabel(p.method)}
                    <span className="ml-2 text-xs text-gray-500">{fmtDateTime(p.at)}</span>
                    {p.reference && (
                      <span className="ml-2 font-mono text-xs text-gray-500">{p.reference}</span>
                    )}
                  </span>
                  <span className="font-medium text-gray-900">{rupees(p.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Footer */}
        <footer className="mt-10 flex items-end justify-between">
          <p className="text-[10px] text-gray-400">
            Computer-generated receipt · printed {fmtDateTime(new Date().toISOString())}
          </p>
          <div className="text-center">
            <div className="mb-1 h-8" />
            <div className="w-40 border-t border-gray-400 pt-1 text-xs text-gray-700">
              Received by
              <div className="text-[10px] text-gray-500">Signature &amp; seal</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** A circular "official stamp" built from the hospital's own name and accent colour. */
function Seal({ accent, name }: { accent: string; name: string }) {
  return (
    <div
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-center"
      style={{ border: `2px solid ${accent}`, color: accent }}
    >
      <span className="px-1 text-[7px] leading-tight font-semibold tracking-wide uppercase">
        {name.length > 26 ? `${name.slice(0, 24)}…` : name}
        <span className="mt-0.5 block text-sm">✚</span>
      </span>
    </div>
  );
}

/** The rotated PAID / PART PAID / DUE stamp, in the status colour. */
function Stamp({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="rounded-md border-2 px-3 py-1 text-sm font-extrabold tracking-widest uppercase"
      style={{ color, borderColor: color, transform: "rotate(-8deg)" }}
    >
      {label}
    </span>
  );
}

function SectionLabel({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-wide uppercase" style={{ color: accent }}>
      {children}
    </h3>
  );
}

export default function ReceiptPage() {
  return <Receipt />;
}
