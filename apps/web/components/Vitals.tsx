"use client";

/**
 * Vitals — the shared way this app draws and captures observations.
 *
 * One component set feeds three surfaces (the patient profile's Vitals tab, the doctor's
 * consultation, the IP treatment sheet) so a blood pressure looks and reads identically wherever
 * it appears. A clinician who learns the colours once knows them everywhere.
 *
 * ── THE FLAGS COME FROM THE API, NEVER FROM HERE ────────────────────────────
 * `reading.flags` and `reading.bmi` are computed server-side. This file must never re-derive
 * them: two copies of a reference range drift, and the copy on the screen would be the one the
 * clinician trusts. The UI's whole job is to paint what the API already decided.
 *
 * Colour is never the only signal — an out-of-range value also carries an ↑/↓ arrow and a
 * title, because a red number is invisible to a colour-blind reader (Doc 08 accessibility).
 */
import { useState, type FormEvent, type JSX } from "react";
import { attemptVitals } from "@medicore/api-client";
import type { ApiClient, TriageLevel, VitalField, VitalsReading } from "@medicore/api-client";
import { Alert, Badge, Button, Card } from "./ui";
import { ErrorAlert } from "./ui";
import { useIdempotencyKey } from "../lib/idempotency";

/** Display metadata per measurement — label, unit, and how many decimals it is quoted to. */
const VITAL_META: Record<VitalField, { label: string; unit: string; step: string; max?: number }> =
  {
    systolic: { label: "Systolic", unit: "mmHg", step: "1" },
    diastolic: { label: "Diastolic", unit: "mmHg", step: "1" },
    pulse: { label: "Pulse", unit: "bpm", step: "1" },
    respiratoryRate: { label: "Resp. rate", unit: "/min", step: "1" },
    temperature: { label: "Temperature", unit: "°C", step: "0.1" },
    spo2: { label: "SpO₂", unit: "%", step: "1", max: 100 },
    weightKg: { label: "Weight", unit: "kg", step: "0.1" },
    heightCm: { label: "Height", unit: "cm", step: "1" },
    painScore: { label: "Pain", unit: "/10", step: "1", max: 10 },
  };

/** The order observations are read in — BP first, because that is what the eye looks for. */
const FIELD_ORDER: VitalField[] = [
  "systolic",
  "diastolic",
  "pulse",
  "respiratoryRate",
  "temperature",
  "spo2",
  "weightKg",
  "heightCm",
  "painScore",
];

const TRIAGE_TONE: Record<TriageLevel, "danger" | "warning" | "neutral"> = {
  critical: "danger",
  urgent: "warning",
  routine: "neutral",
};

function flagClass(flag: "low" | "normal" | "high" | undefined): string {
  if (flag === "high") return "text-[var(--color-danger)] font-semibold";
  if (flag === "low") return "text-[var(--color-warning)] font-semibold";
  return "text-[var(--color-fg)]";
}

/** ↑ / ↓ beside an out-of-range value, so the signal survives without colour. */
function flagArrow(flag: "low" | "normal" | "high" | undefined): string {
  if (flag === "high") return " ↑";
  if (flag === "low") return " ↓";
  return "";
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Blood pressure reads as one number — "120/80" — because that is how it is spoken, charted and
 * remembered. Splitting it into two labelled cells is technically faithful and clinically alien.
 */
function BloodPressure({ reading }: { reading: VitalsReading }): JSX.Element | null {
  const { systolic, diastolic } = reading;
  if (systolic === undefined && diastolic === undefined) return null;
  const worst =
    reading.flags.systolic === "normal" ? reading.flags.diastolic : reading.flags.systolic;
  return (
    <Stat
      label="Blood pressure"
      value={`${systolic ?? "—"}/${diastolic ?? "—"}`}
      unit="mmHg"
      flag={worst}
    />
  );
}

function Stat({
  label,
  value,
  unit,
  flag,
}: {
  label: string;
  value: string | number;
  unit: string;
  flag?: "low" | "normal" | "high";
}): JSX.Element {
  const title =
    flag === "high"
      ? `${label}: above the adult reference range`
      : flag === "low"
        ? `${label}: below the adult reference range`
        : undefined;
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <div className="text-[11px] tracking-wide text-[var(--color-fg-subtle)] uppercase">
        {label}
      </div>
      <div
        className={`mt-0.5 text-sm tabular-nums ${flagClass(flag)}`}
        {...(title ? { title } : {})}
      >
        {value}
        {flagArrow(flag)}
        <span className="ml-1 text-xs font-normal text-[var(--color-fg-muted)]">{unit}</span>
      </div>
    </div>
  );
}

/** One reading as a row of stat tiles — the "latest observations" block. */
export function VitalsSummary({ reading }: { reading: VitalsReading }): JSX.Element {
  const singles = FIELD_ORDER.filter(
    (f) => f !== "systolic" && f !== "diastolic" && reading[f] !== undefined,
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--color-fg-muted)]">
          Recorded {timeOf(reading.recordedAt)}
        </span>
        {reading.triageLevel && (
          <Badge tone={TRIAGE_TONE[reading.triageLevel]}>{reading.triageLevel}</Badge>
        )}
        {reading.abnormal && <Badge tone="warning">Outside normal range</Badge>}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <BloodPressure reading={reading} />
        {singles.map((f) => (
          <Stat
            key={f}
            label={VITAL_META[f].label}
            value={reading[f] as number}
            unit={VITAL_META[f].unit}
            {...(reading.flags[f] ? { flag: reading.flags[f] } : {})}
          />
        ))}
        {reading.bmi !== undefined && <Stat label="BMI" value={reading.bmi} unit="kg/m²" />}
      </div>

      {reading.notes && (
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{reading.notes}</p>
      )}
    </div>
  );
}

/** The visit's chart as a table — every reading, oldest first. */
export function VitalsHistory({ readings }: { readings: VitalsReading[] }): JSX.Element {
  if (readings.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No observations recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <tr>
            <th className="py-2 pr-4 font-medium">When</th>
            <th className="py-2 pr-4 font-medium">BP</th>
            <th className="py-2 pr-4 font-medium">Pulse</th>
            <th className="py-2 pr-4 font-medium">Temp</th>
            <th className="py-2 pr-4 font-medium">SpO₂</th>
            <th className="py-2 pr-4 font-medium">RR</th>
            <th className="py-2 pr-4 font-medium">Weight</th>
            <th className="py-2 font-medium">By</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {readings.map((r) => (
            <tr key={r.id}>
              <td className="py-2 pr-4 whitespace-nowrap text-[var(--color-fg-muted)]">
                {timeOf(r.recordedAt)}
                {r.triageLevel && r.triageLevel !== "routine" && (
                  <span className="ml-1.5">
                    <Badge tone={TRIAGE_TONE[r.triageLevel]}>{r.triageLevel}</Badge>
                  </span>
                )}
              </td>
              <Cell
                value={
                  r.systolic !== undefined || r.diastolic !== undefined
                    ? `${r.systolic ?? "—"}/${r.diastolic ?? "—"}`
                    : undefined
                }
                flag={r.flags.systolic ?? r.flags.diastolic}
              />
              <Cell value={r.pulse} flag={r.flags.pulse} />
              <Cell value={r.temperature} flag={r.flags.temperature} />
              <Cell value={r.spo2} flag={r.flags.spo2} />
              <Cell value={r.respiratoryRate} flag={r.flags.respiratoryRate} />
              <Cell value={r.weightKg} />
              <td className="py-2 text-xs text-[var(--color-fg-muted)]">{r.recordedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  value,
  flag,
}: {
  value?: string | number;
  flag?: "low" | "normal" | "high";
}): JSX.Element {
  return (
    <td className={`py-2 pr-4 tabular-nums whitespace-nowrap ${flagClass(flag)}`}>
      {value ?? <span className="text-[var(--color-fg-subtle)]">—</span>}
      {value !== undefined && flagArrow(flag)}
    </td>
  );
}

/* ── capture ─────────────────────────────────────────────────────────────────── */

type FormState = Partial<Record<VitalField, string>> & {
  triageLevel: TriageLevel | "";
  notes: string;
};

const EMPTY_FORM: FormState = { triageLevel: "", notes: "" };

/**
 * The capture form.
 *
 * Every box may be left blank: a nurse who could only get a pulse on a distressed patient must be
 * able to chart the pulse alone. Blank means "not measured" and is OMITTED from the payload —
 * never sent as 0, which would chart a dead patient.
 */
export function VitalsForm({
  api,
  encounterId,
  onSaved,
  readings,
  recordedBy,
}: {
  api: ApiClient;
  encounterId: string;
  onSaved: (reading: VitalsReading) => void;
  /**
   * The visit's readings as the screen had them a moment ago — the BASELINE reconciliation
   * compares against. Omit it and an ambiguous save can never be resolved to "saved", which is the
   * safe direction: with no snapshot, every reading in a reloaded chart looks new and last night's
   * observation would be reported as this one.
   */
  readings?: readonly VitalsReading[];
  /** The signed-in user. Narrows the reconciliation match; absent widens it, never breaks it. */
  recordedBy?: string;
}): JSX.Element {
  const [f, setF] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Set when a save landed only because we went and looked — worth telling the nurse. */
  const [reconciled, setReconciled] = useState(false);

  /**
   * One key per SUBMISSION, held across the retries of that submission.
   *
   * ── WHY IT IS RENEWED ON EDIT AND NOT ONLY ON SUCCESS ───────────────────────
   * A key that outlives a change to the figures is worse than no key: the server refuses a reused
   * key carrying a different body (`HMS-REQ-002`), so a nurse who corrects a mistyped pulse and
   * saves again would be locked out of charting at all. `lib/idempotency.ts` states the rule —
   * hold it across a retry of the same request, drop it when the user changes what they are
   * asking for — and this is that rule applied to a form.
   */
  const [saveKey, renewKey] = useIdempotencyKey();

  const set = (patch: Partial<FormState>) => {
    // The figures are changing, so the next save is a different request and needs its own key.
    if (error != null) renewKey();
    setError(null);
    setReconciled(false);
    setF((prev) => ({ ...prev, ...patch }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReconciled(false);

    const measured: Partial<Record<VitalField, number>> = {};
    for (const field of FIELD_ORDER) {
      const raw = f[field];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) measured[field] = n;
    }

    if (Object.keys(measured).length === 0 && f.triageLevel === "") {
      setError(new Error("Enter at least one observation before saving."));
      return;
    }

    setSaving(true);
    /**
     * The shared M3 envelope, not a web copy of it: the key makes a retry a REPLAY, and every
     * ambiguous ending is resolved by re-reading the chart rather than by guessing. Nothing here
     * decides whether the observation is normal — `flags`, `abnormal`, `bmi` and `recordedAt` all
     * come back from the server and are rendered as given.
     */
    const outcome = await attemptVitals({
      record: () =>
        api.recordVitals(
          encounterId,
          {
            ...measured,
            ...(f.triageLevel ? { triageLevel: f.triageLevel } : {}),
            ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
          },
          saveKey,
        ),
      reload: () => api.listEncounterVitals(encounterId),
      before: readings,
      ...(recordedBy ? { recordedBy } : {}),
    });
    setSaving(false);

    if (outcome.outcome === "saved") {
      // Only the server's own reading is ever handed on — including on the reconciled path, where
      // it comes from the reloaded chart rather than from a response we never received.
      setF(EMPTY_FORM);
      setReconciled(outcome.reconciled);
      renewKey();
      onSaved(outcome.reading);
      return;
    }

    /**
     * Nothing was charted, or we could not establish that it was. The figures stay on screen and
     * the key is deliberately NOT renewed: pressing save again re-sends the identical request
     * under the identical key, which the server replays instead of writing a second observation.
     */
    setError(outcome.error);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error != null && <ErrorAlert error={error} fallback="Could not save the observations." />}
      {reconciled && (
        <Alert tone="info">
          The reply was lost, so we checked the chart: these observations were saved. Nothing was
          recorded twice.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {FIELD_ORDER.map((field) => {
          const meta = VITAL_META[field];
          return (
            <label key={field} className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg)]">
                {meta.label}
                <span className="ml-1 font-normal text-[var(--color-fg-subtle)]">
                  ({meta.unit})
                </span>
              </span>
              <input
                type="number"
                inputMode="decimal"
                step={meta.step}
                min={0}
                {...(meta.max ? { max: meta.max } : {})}
                value={f[field] ?? ""}
                onChange={(e) => set({ [field]: e.target.value } as Partial<FormState>)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm tabular-nums outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
              />
            </label>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg)]">Priority</span>
          <select
            value={f.triageLevel}
            onChange={(e) => set({ triageLevel: e.target.value as TriageLevel | "" })}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
          >
            <option value="">Not set</option>
            <option value="routine">Routine</option>
            <option value="urgent">Urgent</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg)]">Notes</span>
          <input
            value={f.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Optional — e.g. taken after walking, left arm"
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)]"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-fg-subtle)]">
          Leave a box blank if it was not measured. Ranges shown are adult resting values.
        </p>
        <Button type="submit" loading={saving}>
          Save observations
        </Button>
      </div>
    </form>
  );
}

/**
 * The whole Vitals surface for one visit: latest at the top, the form, then the chart.
 * `canRecord` is UI gating only — the API independently enforces `vitals:record`.
 */
export function VitalsPanel({
  api,
  encounterId,
  readings,
  canRecord,
  onSaved,
  emptyHint,
  recordedBy,
}: {
  api: ApiClient;
  encounterId: string;
  readings: VitalsReading[];
  canRecord: boolean;
  onSaved: (reading: VitalsReading) => void;
  emptyHint?: string;
  /** The signed-in user, for reconciling a lost save against the chart. */
  recordedBy?: string;
}): JSX.Element {
  const latest = readings.length > 0 ? readings[readings.length - 1] : undefined;

  return (
    <div className="space-y-5">
      {latest ? (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-fg)]">Latest observations</h3>
          <VitalsSummary reading={latest} />
        </Card>
      ) : (
        <Alert tone="info">{emptyHint ?? "No observations recorded on this visit yet."}</Alert>
      )}

      {canRecord && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Record observations</h3>
          {/* `readings` is the reconciliation baseline — see `VitalsForm`. */}
          <VitalsForm
            api={api}
            encounterId={encounterId}
            onSaved={onSaved}
            readings={readings}
            {...(recordedBy ? { recordedBy } : {})}
          />
        </Card>
      )}

      {readings.length > 1 && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            This visit&rsquo;s chart
          </h3>
          <VitalsHistory readings={readings} />
        </Card>
      )}
    </div>
  );
}
