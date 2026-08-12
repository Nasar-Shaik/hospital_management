/**
 * Presenting a set of observations — labels, units, and the order a clinician reads them in.
 *
 * ── THE REFERENCE RANGES ARE THE SERVER'S, AND ARE NOT RE-IMPLEMENTED HERE ──
 * `VitalsReading` arrives carrying `flags` (`low` | `normal` | `high` per field), `abnormal` and a
 * derived `bmi`. The api-client says it plainly: those are DERIVED by the API so the ranges live in
 * exactly one place. A phone that decided for itself that a pulse of 55 is low would be a second
 * opinion nobody reviewed, drifting away from the server's the first time a range is corrected —
 * and it would disagree with the web app on the same patient. So this module reads the flags and
 * renders them. It computes nothing clinical.
 *
 * ── UNITS ARE FIXED AND ALWAYS SHOWN ────────────────────────────────────────
 * Temperature °C, weight kg, height cm, blood pressure mmHg. A number without its unit is the
 * oldest medication error there is; there is no compact mode that drops them.
 */
import {
  VITAL_FIELDS,
  type VitalField,
  type VitalFlag,
  type VitalsReading,
} from "@medicore/api-client";
import type { ClinicalTone } from "./encounters";

const LABEL: Record<VitalField, string> = {
  systolic: "BP systolic",
  diastolic: "BP diastolic",
  pulse: "Pulse",
  respiratoryRate: "Respiratory rate",
  temperature: "Temperature",
  spo2: "SpO₂",
  weightKg: "Weight",
  heightCm: "Height",
  painScore: "Pain score",
};

const UNIT: Record<VitalField, string> = {
  systolic: "mmHg",
  diastolic: "mmHg",
  pulse: "bpm",
  respiratoryRate: "/min",
  temperature: "°C",
  spo2: "%",
  weightKg: "kg",
  heightCm: "cm",
  painScore: "/10",
};

/** How many decimals a field is worth. A pulse of `72.0` reads as a machine, not a chart. */
const DECIMALS: Partial<Record<VitalField, number>> = { temperature: 1, weightKg: 1 };

export interface VitalRow {
  field: VitalField;
  label: string;
  /** Already formatted to the field's precision. Never blank — a row only exists if there is one. */
  value: string;
  unit: string;
  /** The SERVER's assessment. `undefined` when it did not flag the field. */
  flag?: VitalFlag;
  tone: ClinicalTone;
}

/**
 * `high` and `low` are both drawn as a warning rather than as danger.
 *
 * Deliberate: `criticalClinical` is reserved for a released critical RESULT (see `results.ts`).
 * An out-of-range observation is advisory — the api-client calls the flags "advisory only, never
 * blocking" — and if a mildly raised temperature looks the same as a panic potassium, the colour
 * that is supposed to stop a doctor in a corridor stops meaning anything.
 */
function toneFor(flag: VitalFlag | undefined): ClinicalTone {
  return flag === "high" || flag === "low" ? "warning" : "neutral";
}

function format(field: VitalField, value: number): string {
  const decimals = DECIMALS[field];
  return decimals === undefined ? String(value) : value.toFixed(decimals);
}

/**
 * The measurements actually present on a reading, in chart order.
 *
 * Every field is optional on the wire — a triage nurse charts a temperature and a pulse, not nine
 * numbers — so absent fields are omitted rather than rendered as a dash. `VITAL_FIELDS` is the
 * api-client's own ordering ("the order a chart reads them"), reused so the phone and the web
 * agree; iterating the object's keys would order by whatever the JSON happened to carry.
 */
export function vitalRows(reading: VitalsReading): VitalRow[] {
  const rows: VitalRow[] = [];
  for (const field of VITAL_FIELDS) {
    const value = reading[field];
    if (typeof value !== "number") continue;
    const flag = reading.flags[field];
    rows.push({
      field,
      label: LABEL[field],
      value: format(field, value),
      unit: UNIT[field],
      ...(flag ? { flag } : {}),
      tone: toneFor(flag),
    });
  }
  return rows;
}

/**
 * `120/80 mmHg` — the one pair that is meaningless read apart.
 *
 * Returned only when BOTH halves are present. A lone systolic is shown as its own row by
 * `vitalRows`; inventing "120/—" would look like a measurement.
 */
export function bloodPressure(reading: VitalsReading): string | undefined {
  const { systolic, diastolic } = reading;
  if (typeof systolic !== "number" || typeof diastolic !== "number") return undefined;
  return `${String(systolic)}/${String(diastolic)} mmHg`;
}

/**
 * The newest reading. `recordedAt` is compared, not array position: `listPatientVitals` documents
 * newest-first and `listEncounterVitals` documents oldest-first, and a helper that trusted the
 * order would silently show the oldest observation as "latest" on exactly one of the two screens.
 */
export function latestReading(readings: readonly VitalsReading[]): VitalsReading | undefined {
  let latest: VitalsReading | undefined;
  for (const reading of readings) {
    if (!latest || reading.recordedAt > latest.recordedAt) latest = reading;
  }
  return latest;
}
