"use client";

/**
 * The discharge summary — the formal document a patient is given when a stay ends.
 *
 * It is the one record of the admission the NEXT clinician will read, so it leads with the final
 * diagnosis and the course of the stay (from the discharge-summary ward note that `dischargeWithSummary`
 * writes), then the discharge medications and the follow-up, and closes with the final settlement —
 * total charges, what the advance covered, and any refund due or balance owed. Composed from data
 * that already exists, hospital-branded, printed outside the app shell for a clean A4 sheet.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ApiClientError,
  type DoctorCard,
  type Encounter,
  type EncounterBilling,
  type Patient,
  type Prescription,
  type PublicSite,
  type Wallet,
  type WardNote,
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
function fmtDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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
function humanise(code: string): string {
  const s = code.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Whole days between admission and discharge (or now) — the length of stay. */
function lengthOfStay(from?: string, to?: string): number {
  if (!from) return 0;
  const a = new Date(from).getTime();
  const b = to ? new Date(to).getTime() : Date.now();
  return Math.max(1, Math.ceil((b - a) / (24 * 3600_000)));
}

function Summary() {
  const { api, user, loading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctor, setDoctor] = useState<DoctorCard | null>(null);
  const [notes, setNotes] = useState<WardNote[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [billing, setBilling] = useState<EncounterBilling | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [site, setSite] = useState<PublicSite | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

      const enc = await api.getEncounter(id);
      setEncounter(enc);
      if (enc.class !== "IP") {
        setError("A discharge summary is for an inpatient admission.");
        return;
      }

      const [pat, doc, wn, rx, bill, wal, theSite] = await Promise.all([
        api.getPatient(enc.patientId),
        enc.doctorId
          ? soft(api.getDoctor(enc.doctorId), null as DoctorCard | null)
          : Promise.resolve(null),
        soft(api.listWardNotes(id), [] as WardNote[]),
        soft(api.listPrescriptions({ encounterId: id, current: true }), [] as Prescription[]),
        soft(api.getEncounterBilling(id), null as EncounterBilling | null),
        soft(api.getWallet(enc.patientId), null as Wallet | null),
        soft(api.getPublicSite(), null as PublicSite | null),
      ]);

      setPatient(pat);
      setDoctor(doc);
      setNotes(wn);
      setPrescriptions(rx);
      setBilling(bill);
      setWallet(wal);
      setSite(theSite);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This admission could not be found."
          : "Could not load this discharge summary.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    if (!authLoading && user) void load();
  }, [authLoading, user, load]);

  const accent = site?.accentColor ?? "#0d9488";
  const hospitalName = site?.displayName ?? site?.hospitalName ?? "Hospital";
  const rxLines = useMemo(() => prescriptions.flatMap((p) => p.lines), [prescriptions]);

  // The formal summary note the discharge wrote; the outcome note stands in for a non-routine ending.
  const summaryNote = useMemo(
    () =>
      notes.find((n) => n.type === "discharge_summary") ??
      notes.find((n) => n.type === "outcome_note"),
    [notes],
  );

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
        <p className="font-medium text-gray-800">Please sign in to view this summary.</p>
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

  const admittedAt = encounter.admittedAt ?? encounter.arrivedAt;
  const los = lengthOfStay(admittedAt, encounter.dischargedAt);
  const finalDiagnosis = summaryNote?.diagnosis ?? encounter.diagnosis;
  const advice = summaryNote?.advice ?? encounter.advice;
  const followUpOn = summaryNote?.followUpOn;

  const totalCharges = billing?.grandTotal ?? 0;
  const paid = billing?.totalPaid ?? 0;
  const outstanding = billing?.outstanding ?? 0;
  const advance = wallet?.balance ?? 0;
  const refundDue = advance > 0 ? advance : 0;

  return (
    <div className="ds-root min-h-screen bg-gray-100 py-8 text-gray-900">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .ds-root { background: #fff !important; padding: 0 !important; }
          .ds-sheet { box-shadow: none !important; margin: 0 !important; width: 100% !important; }
          @page { margin: 14mm; }
        }
      `}</style>

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

      <div className="ds-sheet mx-auto max-w-[820px] bg-white px-10 py-8 shadow-sm">
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

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-gray-700 uppercase">
            Discharge Summary
          </h2>
          {!encounter.dischargedAt && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 uppercase">
              Provisional — not yet discharged
            </span>
          )}
        </div>

        {/* Patient & stay */}
        <section className="mt-3 grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-3 text-sm">
          <div>
            <div className="font-semibold text-gray-900">{patient.name}</div>
            <div className="mt-0.5 text-xs text-gray-600">
              <span className="font-mono">{patient.uhid}</span> · {ageOf(patient.dob)} ·{" "}
              {patient.gender}
              {patient.contact.phone ? ` · ☎ ${patient.contact.phone}` : ""}
            </div>
          </div>
          <div className="text-right text-xs text-gray-700">
            <div>
              <span className="text-gray-500">Admitted:</span> {fmtDate(admittedAt)}
            </div>
            <div>
              <span className="text-gray-500">Discharged:</span>{" "}
              {encounter.dischargedAt ? fmtDate(encounter.dischargedAt) : "—"}
              {" · "}
              <span className="text-gray-500">LOS:</span> {los} day{los === 1 ? "" : "s"}
            </div>
            {encounter.bed && (
              <div>
                <span className="text-gray-500">Bed:</span> {encounter.bed.ward} ·{" "}
                {encounter.bed.bedCode}
              </div>
            )}
            <div>
              <span className="text-gray-500">Consultant:</span> Dr {doctor?.name ?? "—"}
            </div>
            {encounter.disposition && (
              <div>
                <span className="text-gray-500">Outcome:</span> {humanise(encounter.disposition)}
              </div>
            )}
          </div>
        </section>

        <div className="mt-4 space-y-3 text-sm">
          {finalDiagnosis && (
            <Field label="Final diagnosis" accent={accent}>
              {finalDiagnosis}
            </Field>
          )}

          {summaryNote?.text && (
            <Field label="Course of stay & summary" accent={accent}>
              {summaryNote.text}
            </Field>
          )}

          {rxLines.length > 0 && (
            <div>
              <SectionLabel accent={accent}>Discharge medications</SectionLabel>
              <table className="mt-1 w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-300 text-gray-500">
                    <th className="py-1 pr-2 font-medium">#</th>
                    <th className="py-1 pr-2 font-medium">Medicine</th>
                    <th className="py-1 pr-2 font-medium">Dose</th>
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
                      <td className="py-1 pr-2">{humanise(l.frequency)}</td>
                      <td className="py-1 pr-2">{l.durationDays ?? "—"}</td>
                      <td className="py-1 text-gray-600">{l.instructions ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(advice || followUpOn) && (
            <Field label="Advice & follow-up" accent={accent}>
              {advice}
              {followUpOn && (
                <div className={advice ? "mt-1" : ""}>Follow up on {fmtDate(followUpOn)}.</div>
              )}
            </Field>
          )}
        </div>

        {/* Final settlement */}
        <section className="mt-5 rounded-lg border-2 p-4" style={{ borderColor: `${accent}33` }}>
          <SectionLabel accent={accent}>Final settlement</SectionLabel>
          <table className="mt-1.5 w-full text-sm">
            <tbody>
              <tr>
                <td className="py-0.5 text-gray-600">Total charges for the stay</td>
                <td className="py-0.5 text-right font-medium text-gray-900">
                  {rupees(totalCharges)}
                </td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-600">Paid / drawn from advance</td>
                <td className="py-0.5 text-right text-gray-700">{rupees(paid)}</td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-600">Advance balance</td>
                <td
                  className={`py-0.5 text-right ${advance < 0 ? "font-medium text-red-600" : "text-gray-700"}`}
                >
                  {rupees(advance)}
                </td>
              </tr>
            </tbody>
            <tfoot>
              {outstanding > 0 ? (
                <tr className="border-t-2 border-gray-300">
                  <td className="pt-1.5 font-semibold text-red-600">Balance payable</td>
                  <td className="pt-1.5 text-right font-semibold text-red-600">
                    {rupees(outstanding)}
                  </td>
                </tr>
              ) : refundDue > 0 ? (
                <tr className="border-t-2 border-gray-300">
                  <td className="pt-1.5 font-semibold text-green-700">Refund due to patient</td>
                  <td className="pt-1.5 text-right font-semibold text-green-700">
                    {rupees(refundDue)}
                  </td>
                </tr>
              ) : (
                <tr className="border-t-2 border-gray-300">
                  <td className="pt-1.5 font-semibold text-gray-900">Settled in full</td>
                  <td className="pt-1.5 text-right font-semibold text-gray-900">{rupees(0)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </section>

        {/* Signature */}
        <footer className="mt-10 flex items-end justify-between">
          <p className="text-[10px] text-gray-400">
            Computer-generated discharge summary · printed {fmtDateTime(new Date().toISOString())}
          </p>
          <div className="text-center">
            <div className="mb-1 flex h-10 items-end justify-center">
              {doctor?.signature ? (
                <img src={doctor.signature} alt="Signature" className="max-h-10 object-contain" />
              ) : null}
            </div>
            <div className="w-48 border-t border-gray-400 pt-1 text-xs text-gray-700">
              Dr {doctor?.name ?? "—"}
              <div className="text-[10px] text-gray-500">Consultant · signature &amp; seal</div>
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

function Field({
  label,
  accent,
  children,
}: {
  label: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <div>
      <SectionLabel accent={accent}>{label}</SectionLabel>
      <div className="mt-0.5 whitespace-pre-wrap text-gray-900">{children}</div>
    </div>
  );
}

export default function DischargeSummaryPage() {
  return <Summary />;
}
