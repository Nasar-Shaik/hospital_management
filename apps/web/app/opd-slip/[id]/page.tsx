"use client";

/**
 * The OPD slip — the one page the patient takes home.
 *
 * ── A DOCUMENT, NOT A SCREEN ─────────────────────────────────────────────────
 * This is the printed record of a visit: who saw the patient, what was found, what was ordered
 * and prescribed, and what it cost. It is rendered OUTSIDE the app shell (no sidebar, no nav) so
 * that `window.print()` produces a clean A4 sheet, and everything on it is COMPOSED from data that
 * already exists — the encounter, its orders and results, its prescriptions, and its bill — with
 * the hospital's own branding for the header and seal. Nothing here is fabricated: the seal is the
 * hospital's own name in its own accent colour, and the signature block prints the doctor's name.
 *
 * Optional strands (the bill, uploaded reports) are fetched softly: a doctor without `billing:read`
 * still gets a slip, just without the money section, rather than a blank page.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ApiClientError,
  type Bill,
  type Encounter,
  type Patient,
  type Prescription,
  type PublicSite,
  type Order,
} from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { rupees } from "../../../lib/money";

function ageOf(dob?: string): string {
  if (!dob) return "—";
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years--;
  return `${years}y`;
}

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

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** `once_daily` → `Once daily`. Frequencies/routes are stored as codes; humanise for the page. */
function humanise(code: string): string {
  const s = code.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Slip() {
  const { api, user } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctorName, setDoctorName] = useState<string>("—");
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [bill, setBill] = useState<Bill | null>(null);
  const [site, setSite] = useState<PublicSite | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

      const enc = await api.getEncounter(id);
      if (!enc) {
        setError("This visit could not be found.");
        return;
      }
      setEncounter(enc);

      const [pat, docs, ords, rx, theBill, theSite] = await Promise.all([
        api.getPatient(enc.patientId),
        soft(api.listDoctors(), [] as { id: string; name: string }[]),
        soft(api.listOrders({ encounterId: id, limit: 100 }), {
          items: [] as Order[],
          meta: { page: 1, limit: 0 },
        }),
        soft(api.listPrescriptions({ encounterId: id, current: true }), [] as Prescription[]),
        soft(api.getBill(id), null as Bill | null),
        soft(api.getPublicSite(), null as PublicSite | null),
      ]);

      setPatient(pat);
      setDoctorName(docs.find((d) => d.id === enc.doctorId)?.name ?? "—");
      setOrders(ords.items);
      setPrescriptions(rx);
      setBill(theBill);
      setSite(theSite);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This visit could not be found."
          : "Could not load this visit.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const accent = site?.accentColor ?? "#0d9488";
  const hospitalName = site?.displayName ?? site?.hospitalName ?? "Hospital";
  const rxLines = useMemo(() => prescriptions.flatMap((p) => p.lines), [prescriptions]);
  const rxNotes = useMemo(
    () => prescriptions.map((p) => p.notes).filter((n): n is string => Boolean(n)),
    [prescriptions],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
      </div>
    );
  }

  if (error || !encounter || !patient) {
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

  const paid = bill?.invoice?.paid ?? 0;
  const billTotal = bill?.total ?? 0;
  const balance = Math.max(0, billTotal - paid);

  return (
    <div className="opd-root min-h-screen bg-gray-100 py-8 text-gray-900">
      {/* Print-only styling: hide the toolbar, drop the grey backdrop, tighten margins. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .opd-root { background: #fff !important; padding: 0 !important; }
          .opd-sheet { box-shadow: none !important; margin: 0 !important; width: 100% !important; }
          @page { margin: 14mm; }
        }
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="no-print mx-auto mb-4 flex max-w-[820px] items-center justify-between px-4">
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

      {/* The sheet */}
      <div className="opd-sheet mx-auto max-w-[820px] bg-white px-10 py-8 shadow-sm">
        {/* Header */}
        <header
          className="flex items-start justify-between gap-4 border-b-2 pb-4"
          style={{ borderColor: accent }}
        >
          <div>
            <h1 className="text-2xl font-bold" style={{ color: accent }}>
              {hospitalName}
            </h1>
            {site?.tagline && <p className="text-sm text-gray-500">{site.tagline}</p>}
            <div className="mt-1 text-xs text-gray-600">
              {site?.contact.address && <div>{site.contact.address}</div>}
              <div className="flex gap-3">
                {site?.contact.phone && <span>☎ {site.contact.phone}</span>}
                {site?.contact.email && <span>✉ {site.contact.email}</span>}
              </div>
            </div>
          </div>
          <Seal accent={accent} name={hospitalName} />
        </header>

        {/* Title row */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-gray-700 uppercase">
            OPD Summary
          </h2>
          <div className="text-right text-xs text-gray-600">
            <div>{fmtDate(encounter.arrivedAt)}</div>
            {encounter.token !== undefined && <div>Token {encounter.token}</div>}
          </div>
        </div>

        {/* Patient & doctor */}
        <section className="mt-3 grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-3 text-sm">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-gray-900">{patient.name}</span>
              {encounter.express && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                  style={{ backgroundColor: `${accent}20`, color: accent }}
                >
                  Express
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-gray-600">
              <span className="font-mono">{patient.uhid}</span> · {ageOf(patient.dob)} ·{" "}
              {patient.gender}
              {patient.contact.phone ? ` · ☎ ${patient.contact.phone}` : ""}
            </div>
          </div>
          <div className="text-right">
            <div className="font-semibold text-gray-900">Dr {doctorName}</div>
            <div className="text-xs text-gray-600">Consulting doctor</div>
          </div>
        </section>

        {/* Clinical narrative */}
        <div className="mt-4 space-y-3 text-sm">
          {encounter.reason && <Field label="Chief complaint">{encounter.reason}</Field>}
          {encounter.diagnosis && <Field label="Diagnosis">{encounter.diagnosis}</Field>}

          {orders.length > 0 && (
            <div>
              <SectionLabel accent={accent}>Investigations</SectionLabel>
              <ul className="mt-1 space-y-1">
                {orders.map((o) => (
                  <li key={o.id} className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-gray-900">
                      {o.name}
                      <span className="ml-1 text-xs text-gray-500">({o.category})</span>
                    </span>
                    <span className="text-right text-gray-700">
                      {o.result?.summary
                        ? o.result.summary
                        : o.status === "released"
                          ? "See report"
                          : humanise(o.status)}
                      {o.result?.critical && (
                        <span className="ml-1 font-semibold text-red-600">⚠ critical</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rxLines.length > 0 && (
            <div>
              <SectionLabel accent={accent}>Rx — Prescription</SectionLabel>
              <table className="mt-1 w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-300 text-gray-500">
                    <th className="py-1 pr-2 font-medium">#</th>
                    <th className="py-1 pr-2 font-medium">Medicine</th>
                    <th className="py-1 pr-2 font-medium">Dose</th>
                    <th className="py-1 pr-2 font-medium">Route</th>
                    <th className="py-1 pr-2 font-medium">Frequency</th>
                    <th className="py-1 pr-2 font-medium">Days</th>
                    <th className="py-1 font-medium">Instructions</th>
                  </tr>
                </thead>
                <tbody>
                  {rxLines.map((l, i) => (
                    <tr key={i} className="border-b border-gray-100 align-top">
                      <td className="py-1 pr-2 text-gray-500">{i + 1}</td>
                      <td className="py-1 pr-2 font-medium text-gray-900">{l.drugName}</td>
                      <td className="py-1 pr-2">{l.dose}</td>
                      <td className="py-1 pr-2">{humanise(l.route)}</td>
                      <td className="py-1 pr-2">{humanise(l.frequency)}</td>
                      <td className="py-1 pr-2">{l.durationDays ?? "—"}</td>
                      <td className="py-1 text-gray-600">{l.instructions ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(encounter.advice || rxNotes.length > 0) && (
            <Field label="Advice">
              {encounter.advice}
              {rxNotes.map((n, i) => (
                <div key={i} className={encounter.advice || i > 0 ? "mt-1" : ""}>
                  {n}
                </div>
              ))}
            </Field>
          )}
        </div>

        {/* Bill / receipt */}
        {bill && bill.lines.length > 0 && (
          <section className="mt-5">
            <SectionLabel accent={accent}>Bill</SectionLabel>
            <table className="mt-1 w-full border-collapse text-sm">
              <tbody>
                {bill.lines.map((l, i) => (
                  <tr key={`${l.code}-${i}`} className="border-b border-gray-100">
                    <td className="py-1 text-gray-800">{l.description}</td>
                    <td className="py-1 pr-2 text-right text-gray-500">
                      {l.quantity > 1 ? `× ${l.quantity}` : ""}
                    </td>
                    <td className="py-1 text-right font-medium text-gray-900">
                      {rupees(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-sm">
                <tr className="border-t-2 border-gray-300">
                  <td className="pt-1.5 font-semibold text-gray-900" colSpan={2}>
                    Total
                  </td>
                  <td className="pt-1.5 text-right font-semibold text-gray-900">
                    {rupees(billTotal)}
                  </td>
                </tr>
                <tr>
                  <td className="text-gray-600" colSpan={2}>
                    Paid
                  </td>
                  <td className="text-right text-gray-700">{rupees(paid)}</td>
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
            {bill.invoice?.number && (
              <p className="mt-1 text-xs text-gray-500">
                Invoice {bill.invoice.number} · {bill.invoice.status}
              </p>
            )}
          </section>
        )}

        {/* Signature + seal */}
        <footer className="mt-10 flex items-end justify-between">
          <p className="text-[10px] text-gray-400">
            Computer-generated OPD summary · printed {fmtDateTime(new Date().toISOString())}
          </p>
          <div className="text-center">
            <div className="mb-1 h-10" />
            <div className="w-48 border-t border-gray-400 pt-1 text-xs text-gray-700">
              Dr {doctorName}
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
      className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-center"
      style={{ border: `2px solid ${accent}`, color: accent }}
    >
      <span className="px-1 text-[8px] leading-tight font-semibold tracking-wide uppercase">
        {name.length > 26 ? `${name.slice(0, 24)}…` : name}
        <span className="mt-0.5 block text-sm">✚</span>
      </span>
    </div>
  );
}

function SectionLabel({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-wide uppercase" style={{ color: accent }}>
      {children}
    </h3>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-xs font-semibold tracking-wide text-gray-500 uppercase">{label}</span>
      <div className="whitespace-pre-wrap text-gray-900">{children}</div>
    </div>
  );
}

export default function OpdSlipPage() {
  return <Slip />;
}
