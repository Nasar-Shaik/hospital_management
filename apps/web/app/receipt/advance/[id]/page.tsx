"use client";

/**
 * The advance receipt — proof of an advance a patient (or their relatives) paid: an OP advance, or
 * the admission advance a ward stay draws down. It is the wallet-deposit twin of the bill receipt
 * (`/receipt/[invoiceId]`): same printable chrome, but the money here is an ADVANCE the patient holds,
 * not a payment against one bill. Reprintable later from its id — the receipts register links here.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  ApiClientError,
  type Patient,
  type PublicSite,
  type WalletEntry,
} from "@medicore/api-client";
import { useAuth } from "../../../../components/AuthProvider";
import { rupees } from "../../../../lib/money";

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

function methodLabel(method?: string): string {
  if (!method) return "—";
  if (method === "netbanking") return "Net banking";
  if (method === "upi") return "UPI";
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function Advance() {
  const { api, user, loading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [entry, setEntry] = useState<WalletEntry | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [site, setSite] = useState<PublicSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
      const e = await api.getWalletEntry(id);
      setEntry(e);
      const [pat, theSite] = await Promise.all([
        soft(api.getPatient(e.patientId), null as Patient | null),
        soft(api.getPublicSite(), null as PublicSite | null),
      ]);
      setPatient(pat);
      setSite(theSite);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This advance receipt could not be found."
          : "Could not load this receipt.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    if (!authLoading && user) void load();
  }, [authLoading, user, load]);

  if (authLoading || (user && loading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
      </div>
    );
  }

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

  if (error || !entry) {
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
  const receiptNo = `ADV-${entry.id.slice(-8).toUpperCase()}`;
  const purpose = entry.reason ?? "Advance deposit";

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

      <div className="rcpt-sheet mx-auto max-w-[620px] bg-white px-9 py-8 shadow-sm">
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

        <div className="mt-4 flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-[0.2em] text-gray-700 uppercase">
              Advance Receipt
            </h2>
            <div className="mt-1 text-xs text-gray-600">
              <div>
                Receipt No:{" "}
                <span className="font-mono font-semibold text-gray-900">{receiptNo}</span>
              </div>
              <div>Date: {fmtDateTime(entry.at)}</div>
            </div>
          </div>
          <Stamp label="RECEIVED" color="#16a34a" />
        </div>

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

        {/* The money — an advance the patient now holds, drawn down by later bills. */}
        <section className="mt-5 rounded-lg border-2 p-4" style={{ borderColor: `${accent}33` }}>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs tracking-wide text-gray-500 uppercase">Advance received</p>
              <p className="mt-0.5 text-sm text-gray-700">{purpose}</p>
              <p className="mt-0.5 text-xs text-gray-500">Paid by {methodLabel(entry.method)}</p>
            </div>
            <p className="text-3xl font-bold" style={{ color: accent }}>
              {rupees(entry.amount)}
            </p>
          </div>
          <p className="mt-3 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
            This is an advance held to the patient&apos;s account. Treatment, ward and test charges
            are drawn from it; any balance is refundable on discharge.
          </p>
        </section>

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

export default function AdvanceReceiptPage() {
  return <Advance />;
}
