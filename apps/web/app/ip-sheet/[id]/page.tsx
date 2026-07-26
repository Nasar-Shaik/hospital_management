"use client";

/**
 * The inpatient treatment sheet — the day-by-day record of an admission.
 *
 * ── WHY THIS IS NOT THE OPD SLIP ─────────────────────────────────────────────
 * An OP visit is one moment; an admission is a STORY told over days. So this sheet is a chronology:
 * for each calendar day of the stay it gathers what was written (progress notes), what was ordered
 * and found (tests), what was prescribed (drugs), what it cost (charges), and what was drawn from the
 * advance that day. It is composed from data that already exists — the encounter, its ward notes,
 * orders, prescriptions, charges and the patient's advance ledger — with the hospital's own branding,
 * and printed outside the app shell for a clean A4 record for the patient's file.
 *
 * Money is shown INLINE, per day, because an admitted patient's care is paid from an advance that is
 * drawn down as the stay goes on — "what was done today, and what it drew" is the question the ward
 * and the family both ask.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  ApiClientError,
  type DoctorCard,
  type Encounter,
  type EncounterBilling,
  type EncounterCharge,
  type Order,
  type Patient,
  type Prescription,
  type PublicSite,
  type Wallet,
  type WalletEntry,
  type VitalField,
  type VitalsReading,
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

/** Local calendar-day key `YYYY-MM-DD` — the axis the whole sheet is grouped on. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
function walletLabel(type: WalletEntry["type"]): string {
  if (type === "deposit") return "Advance received";
  if (type === "debit") return "Drawn for this stay";
  if (type === "refund") return "Refunded";
  return "Reversal";
}

interface DayBucket {
  key: string;
  vitals: VitalsReading[];
  notes: WardNote[];
  orders: Order[];
  prescriptions: Prescription[];
  charges: EncounterCharge[];
  wallet: WalletEntry[];
}

function Sheet() {
  const { api, user, loading: authLoading } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctor, setDoctor] = useState<DoctorCard | null>(null);
  const [notes, setNotes] = useState<WardNote[]>([]);
  const [vitals, setVitals] = useState<VitalsReading[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [charges, setCharges] = useState<EncounterCharge[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [billing, setBilling] = useState<EncounterBilling | null>(null);
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
        setError(
          "This is not an inpatient admission — the treatment sheet is for admitted patients.",
        );
        return;
      }

      const [pat, doc, wn, vit, ords, rx, chg, wal, bill, theSite] = await Promise.all([
        api.getPatient(enc.patientId),
        enc.doctorId
          ? soft(api.getDoctor(enc.doctorId), null as DoctorCard | null)
          : Promise.resolve(null),
        soft(api.listWardNotes(id), [] as WardNote[]),
        soft(api.listEncounterVitals(id), [] as VitalsReading[]),
        soft(api.listOrders({ encounterId: id, limit: 100 }), {
          items: [] as Order[],
          meta: { page: 1, limit: 0 },
        }),
        soft(api.listPrescriptions({ encounterId: id }), [] as Prescription[]),
        soft(api.getCharges(id), [] as EncounterCharge[]),
        soft(api.getWallet(enc.patientId), null as Wallet | null),
        soft(api.getEncounterBilling(id), null as EncounterBilling | null),
        soft(api.getPublicSite(), null as PublicSite | null),
      ]);

      setPatient(pat);
      setDoctor(doc);
      setNotes(wn);
      setVitals(vit);
      setOrders(ords.items);
      setPrescriptions(rx);
      setCharges(chg.filter((c) => !c.voided));
      setWallet(wal);
      setBilling(bill);
      setSite(theSite);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "HMS-GEN-404"
          ? "This admission could not be found."
          : "Could not load this treatment sheet.",
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

  // The stay window, and every advance movement that falls inside it (deposits may lack an
  // encounterId, so we bound by the stay's dates rather than by id — during an admission, the
  // patient's advance activity IS the stay's).
  const stayFrom = encounter?.admittedAt ?? encounter?.arrivedAt;
  const stayTo = encounter?.dischargedAt;
  const stayWalletEntries = useMemo(() => {
    if (!wallet || !stayFrom) return [];
    const from = new Date(stayFrom).getTime();
    const to = stayTo ? new Date(stayTo).getTime() : Date.now();
    return wallet.entries.filter((e) => {
      const t = new Date(e.at).getTime();
      return t >= from - 60_000 && t <= to + 24 * 3600_000;
    });
  }, [wallet, stayFrom, stayTo]);

  const days = useMemo(() => {
    const map = new Map<string, DayBucket>();
    const bucket = (key: string): DayBucket => {
      let b = map.get(key);
      if (!b) {
        b = { key, vitals: [], notes: [], orders: [], prescriptions: [], charges: [], wallet: [] };
        map.set(key, b);
      }
      return b;
    };
    if (stayFrom) bucket(dayKey(stayFrom)); // the admission day always shows, even if quiet
    vitals.forEach((v) => bucket(dayKey(v.recordedAt)).vitals.push(v));
    notes.forEach((n) => bucket(dayKey(n.at)).notes.push(n));
    orders.forEach((o) => bucket(dayKey(o.orderedAt)).orders.push(o));
    prescriptions.forEach((p) =>
      bucket(dayKey(p.signedAt ?? p.prescribedAt)).prescriptions.push(p),
    );
    charges.forEach((c) => bucket(dayKey(c.postedAt)).charges.push(c));
    stayWalletEntries.forEach((e) => bucket(dayKey(e.at)).wallet.push(e));
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [vitals, notes, orders, prescriptions, charges, stayWalletEntries, stayFrom]);

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
        <p className="font-medium text-gray-800">Please sign in to view this treatment sheet.</p>
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

  const advance = wallet?.balance ?? 0;
  const totalCharges = billing?.grandTotal ?? 0;
  const paid = billing?.totalPaid ?? 0;
  const outstanding = billing?.outstanding ?? 0;
  const admitDayKey = stayFrom ? dayKey(stayFrom) : days[0]?.key;

  return (
    <div className="ip-root min-h-screen bg-gray-100 py-8 text-gray-900">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .ip-root { background: #fff !important; padding: 0 !important; }
          .ip-sheet { box-shadow: none !important; margin: 0 !important; width: 100% !important; }
          .day-block { break-inside: avoid; }
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

      <div className="ip-sheet mx-auto max-w-[820px] bg-white px-10 py-8 shadow-sm">
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

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-gray-700 uppercase">
            Inpatient Treatment Record
          </h2>
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase"
            style={{ backgroundColor: `${accent}18`, color: accent }}
          >
            {encounter.dischargedAt
              ? `Discharged${encounter.disposition ? ` · ${humanise(encounter.disposition)}` : ""}`
              : "Admitted"}
          </span>
        </div>

        {/* Patient & admission */}
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
              <span className="text-gray-500">Admitted:</span> {fmtDateTime(stayFrom)}
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
            {encounter.dischargedAt && (
              <div>
                <span className="text-gray-500">Discharged:</span>{" "}
                {fmtDateTime(encounter.dischargedAt)}
              </div>
            )}
          </div>
        </section>

        {encounter.diagnosis && (
          <div className="mt-3 text-sm">
            <SectionLabel accent={accent}>Working diagnosis</SectionLabel>
            <p className="mt-0.5 whitespace-pre-wrap text-gray-900">{encounter.diagnosis}</p>
          </div>
        )}

        {/* Account summary — the money at a glance */}
        <section className="mt-4 grid grid-cols-4 gap-2 text-center">
          <Stat
            label="Advance balance"
            value={rupees(advance)}
            danger={advance < 0}
            accent={accent}
          />
          <Stat label="Total charges" value={rupees(totalCharges)} accent={accent} />
          <Stat label="Paid / drawn" value={rupees(paid)} accent={accent} />
          <Stat
            label="Outstanding"
            value={rupees(outstanding)}
            danger={outstanding > 0}
            accent={accent}
          />
        </section>

        {/* The day-by-day story */}
        <section className="mt-6 space-y-5">
          <SectionLabel accent={accent}>Daily record</SectionLabel>
          {days.length === 0 ? (
            <p className="text-sm text-gray-500">No entries recorded yet.</p>
          ) : (
            days.map((d, i) => (
              <Day
                key={d.key}
                bucket={d}
                index={i + 1}
                isAdmitDay={d.key === admitDayKey}
                accent={accent}
              />
            ))
          )}
        </section>

        {/* Signature */}
        <footer className="mt-10 flex items-end justify-between">
          <p className="text-[10px] text-gray-400">
            Computer-generated inpatient record · printed {fmtDateTime(new Date().toISOString())}
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

/** One day of the stay. */
/**
 * One reading as a single charted line — "BP 130/85 ↑ · HR 92 · T 38.2 ↑ · SpO2 96% · RR 18".
 *
 * Only what was actually measured appears; a blank is a measurement that was not taken, and
 * printing "—" for it would fill a ward chart with noise. Arrows come from the API's own flags,
 * so the sheet and the screen agree about what is abnormal.
 */
function obsLine(v: VitalsReading): string {
  const mark = (field: VitalField) =>
    v.flags[field] === "high" ? " \u2191" : v.flags[field] === "low" ? " \u2193" : "";

  const parts: string[] = [];
  if (v.systolic !== undefined || v.diastolic !== undefined) {
    parts.push(
      `BP ${String(v.systolic ?? "\u2014")}/${String(v.diastolic ?? "\u2014")}${mark("systolic") || mark("diastolic")}`,
    );
  }
  if (v.pulse !== undefined) parts.push(`HR ${String(v.pulse)}${mark("pulse")}`);
  if (v.temperature !== undefined)
    parts.push(`T ${String(v.temperature)}\u00b0C${mark("temperature")}`);
  if (v.spo2 !== undefined) parts.push(`SpO2 ${String(v.spo2)}%${mark("spo2")}`);
  if (v.respiratoryRate !== undefined)
    parts.push(`RR ${String(v.respiratoryRate)}${mark("respiratoryRate")}`);
  if (v.weightKg !== undefined) parts.push(`Wt ${String(v.weightKg)}kg`);
  if (v.painScore !== undefined) parts.push(`Pain ${String(v.painScore)}/10`);
  return parts.join(" \u00b7 ");
}

function Day({
  bucket,
  index,
  isAdmitDay,
  accent,
}: {
  bucket: DayBucket;
  index: number;
  isAdmitDay: boolean;
  accent: string;
}) {
  const daySpend = bucket.charges.reduce((sum, c) => sum + c.amount, 0);

  return (
    <div className="day-block">
      <div className="flex items-baseline justify-between border-b border-gray-200 pb-1">
        <h4 className="text-sm font-semibold text-gray-900">
          Day {index} · {dayLabel(bucket.key)}
          {isAdmitDay && (
            <span
              className="ml-2 text-[10px] font-semibold tracking-wide uppercase"
              style={{ color: accent }}
            >
              Admission
            </span>
          )}
        </h4>
        {daySpend > 0 && (
          <span className="text-xs text-gray-500">
            Charged <span className="font-medium text-gray-800">{rupees(daySpend)}</span>
          </span>
        )}
      </div>

      <div className="mt-2 space-y-2.5 text-sm">
        {/*
          The observation round leads the day, the way it does on a paper chart: the nurse's
          obs are the first thing written and the first thing anyone reading the day looks for.
          Out-of-range values carry an arrow, never colour alone — this sheet gets PRINTED, and
          most ward printers are monochrome.
        */}
        {bucket.vitals.map((v) => (
          <div key={v.id} className="flex gap-2">
            <span className="w-12 shrink-0 text-xs text-gray-400">{time(v.recordedAt)}</span>
            <div>
              <span className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
                Observations
              </span>
              <p className="text-gray-800">
                {obsLine(v)}
                {v.triageLevel && v.triageLevel !== "routine" && (
                  <span className="ml-1.5 font-semibold uppercase">· {v.triageLevel}</span>
                )}
              </p>
              {v.notes && <p className="text-xs text-gray-500">{v.notes}</p>}
            </div>
          </div>
        ))}
        {bucket.notes.map((n) => (
          <div key={n.id} className="flex gap-2">
            <span className="w-12 shrink-0 text-xs text-gray-400">{time(n.at)}</span>
            <div>
              <span className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
                {humanise(n.type)}
              </span>
              <p className="whitespace-pre-wrap text-gray-800">{n.text}</p>
            </div>
          </div>
        ))}

        {bucket.orders.length > 0 && (
          <Line label="Investigations" accent={accent}>
            {bucket.orders.map((o) => (
              <div key={o.id} className="flex items-start justify-between gap-3">
                <span className="text-gray-800">
                  {o.name} <span className="text-xs text-gray-500">({o.category})</span>
                </span>
                <span className="text-right text-xs text-gray-600">
                  {o.result?.summary ??
                    (o.status === "released" ? "See report" : humanise(o.status))}
                  {o.result?.critical && (
                    <span className="ml-1 font-semibold text-red-600">⚠ critical</span>
                  )}
                </span>
              </div>
            ))}
          </Line>
        )}

        {bucket.prescriptions.flatMap((p) => p.lines).length > 0 && (
          <Line label="Medications" accent={accent}>
            {bucket.prescriptions.flatMap((p) =>
              p.lines.map((l, i) => (
                <div key={`${p.id}-${i}`} className="text-gray-800">
                  {l.drugName}
                  <span className="text-xs text-gray-500">
                    {" "}
                    · {l.dose} · {humanise(l.frequency)}
                    {l.durationDays ? ` · ${l.durationDays}d` : ""}
                  </span>
                </div>
              )),
            )}
          </Line>
        )}

        {bucket.charges.length > 0 && (
          <Line label="Charges" accent={accent}>
            {bucket.charges.map((c) => (
              <div key={c.id} className="flex items-baseline justify-between gap-3">
                <span className="text-gray-700">
                  {c.description}
                  {c.quantity > 1 ? (
                    <span className="text-xs text-gray-500"> × {c.quantity}</span>
                  ) : null}
                </span>
                <span className="font-medium text-gray-900">{rupees(c.amount)}</span>
              </div>
            ))}
          </Line>
        )}

        {bucket.wallet.map((e) => (
          <div key={e.id} className="flex items-baseline justify-between gap-3">
            <span className="text-xs" style={{ color: accent }}>
              {walletLabel(e.type)}
              {e.method ? ` · ${e.method}` : ""}
            </span>
            <span
              className={`text-xs font-medium ${e.type === "deposit" ? "text-green-700" : "text-gray-700"}`}
            >
              {e.type === "deposit" || e.type === "reversal" ? "+" : "−"}
              {rupees(e.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Line({ label, accent, children }: { label: string; accent: string; children: ReactNode }) {
  return (
    <div className="rounded-md bg-gray-50 p-2">
      <span className="text-[10px] font-semibold tracking-wide uppercase" style={{ color: accent }}>
        {label}
      </span>
      <div className="mt-0.5 space-y-0.5">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-2">
      <div className="text-[10px] tracking-wide text-gray-500 uppercase">{label}</div>
      <div className="text-sm font-bold" style={{ color: danger ? "#dc2626" : accent }}>
        {value}
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

export default function IpSheetPage() {
  return <Sheet />;
}
