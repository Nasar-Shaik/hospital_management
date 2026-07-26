/**
 * Vitals service — recording observations, and saying which of them are out of range.
 *
 * ── THE FLAGS ARE ADVISORY, AND THAT IS A DESIGN DECISION ───────────────────
 * `assess()` labels each value low / normal / high. Nothing in this codebase branches on the
 * result: it does not block a save, refuse a prescription, or change a price. It exists so the
 * abnormal number is the one a tired clinician's eye lands on first, at 3am, on a screen full
 * of numbers. Software that *acts* on a threshold has to be right about every patient; software
 * that merely draws attention only has to be useful, and the clinician stays the decision-maker.
 *
 * ── THE RANGES ARE ADULT RANGES, AND THE CODE SAYS SO ───────────────────────
 * These are resting adult reference ranges. A newborn's normal pulse is ~140 and would be
 * flagged "high" here; a child's respiratory rate likewise. Age-banded paediatric ranges are a
 * real feature with real clinical sign-off attached, and pretending to have them by guessing
 * numbers would be worse than the honest limitation — a paediatric chart that says "normal"
 * when it has never been told the patient is four years old is a false reassurance. Until that
 * work is done, the flags are documented as adult-only and shown as a hint, never as a verdict.
 */
import { AppError } from "../../core/errors/appError.js";
import { getEncounter } from "../encounters/index.js";
import * as repo from "./vitals.repository.js";
import { VITAL_FIELDS, type VitalField } from "./vitals.repository.js";
import type { TriageLevel } from "./vitals.model.js";

export type { VitalsReading } from "./vitals.repository.js";
export { VITAL_FIELDS, type VitalField } from "./vitals.repository.js";

/** Where one measurement sits against its reference range. */
export type VitalFlag = "low" | "normal" | "high";

/** Inclusive normal band for an adult at rest. */
interface Range {
  low: number;
  high: number;
}

/**
 * Resting ADULT reference ranges. See the header for why there are no paediatric bands.
 * `heightCm` has no range — a height is not "abnormal", it is just a height.
 */
const RANGES: Partial<Record<VitalField, Range>> = {
  systolic: { low: 90, high: 140 },
  diastolic: { low: 60, high: 90 },
  pulse: { low: 60, high: 100 },
  respiratoryRate: { low: 12, high: 20 },
  temperature: { low: 36.1, high: 37.5 },
  spo2: { low: 95, high: 100 },
  painScore: { low: 0, high: 3 },
};

/** The flag for one measurement, or undefined when the field has no reference range. */
export function flagFor(field: VitalField, value: number): VitalFlag | undefined {
  const range = RANGES[field];
  if (!range) return undefined;
  if (value < range.low) return "low";
  if (value > range.high) return "high";
  return "normal";
}

/**
 * Body mass index, to one decimal.
 *
 * Returned only when BOTH weight and height are present on the SAME reading. Carrying a height
 * forward from an older reading to pair with today's weight would silently compute a BMI from
 * two different days — usually harmless in an adult, and completely wrong in a growing child or
 * anyone measured on a different scale.
 */
export function bmiOf(reading: { weightKg?: number; heightCm?: number }): number | undefined {
  const { weightKg, heightCm } = reading;
  if (typeof weightKg !== "number" || typeof heightCm !== "number" || heightCm <= 0) {
    return undefined;
  }
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

/** A reading, plus the derived reading-of-the-reading the UI paints. */
export interface AssessedVitals extends repo.VitalsReading {
  /** Per-field flags. Only fields that were recorded AND have a range appear. */
  flags: Partial<Record<VitalField, VitalFlag>>;
  /** True when at least one recorded value is outside its range — the "look here" bit. */
  abnormal: boolean;
  bmi?: number;
}

export function assess(reading: repo.VitalsReading): AssessedVitals {
  const flags: Partial<Record<VitalField, VitalFlag>> = {};
  let abnormal = false;

  for (const field of VITAL_FIELDS) {
    const value = reading[field];
    if (typeof value !== "number") continue;
    const flag = flagFor(field, value);
    if (!flag) continue;
    flags[field] = flag;
    if (flag !== "normal") abnormal = true;
  }

  const bmi = bmiOf(reading);
  return { ...reading, flags, abnormal, ...(bmi !== undefined ? { bmi } : {}) };
}

export interface RecordVitalsInput extends Partial<Record<VitalField, number>> {
  encounterId: string;
  triageLevel?: TriageLevel;
  notes?: string;
  /** When the observations were TAKEN. Defaults to now; may be back-dated for a paper catch-up. */
  recordedAt?: Date;
}

/**
 * Charts one set of observations against a visit.
 *
 * The encounter must exist — a reading attached to an encounterId nobody opened is an
 * observation attached to nothing, and the likeliest cause is a stale id. The patient is taken
 * FROM the encounter rather than from the caller: it is the one source that cannot disagree with
 * itself, so a reading can never be filed against a different patient than the visit it says it
 * belongs to.
 */
export async function recordVitals(input: RecordVitalsInput): Promise<AssessedVitals> {
  const measured: Partial<Record<VitalField, number>> = {};
  for (const field of VITAL_FIELDS) {
    const value = input[field];
    if (typeof value === "number") measured[field] = value;
  }

  // An empty reading is not an observation. Without this, a mis-wired form would quietly file
  // rows of nothing, and a chart of empty rows looks like care that was given and was not.
  if (Object.keys(measured).length === 0 && input.triageLevel === undefined) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      vitals: ["record at least one observation"],
    });
  }

  const recordedAt = input.recordedAt ?? new Date();
  // A reading stamped in the future is a typo (a mis-keyed year), and it would sort to the top
  // of every chart it appears in, displacing the real latest observation.
  if (recordedAt.getTime() > Date.now() + 60_000) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      recordedAt: ["observations cannot be recorded in the future"],
    });
  }

  const encounter = await getEncounter(input.encounterId);
  if (!encounter) {
    throw new AppError("HMS-GEN-404", 404, "Encounter not found", {
      encounterId: input.encounterId,
    });
  }

  const created = await repo.create({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    ...measured,
    ...(input.triageLevel ? { triageLevel: input.triageLevel } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(encounter.branchId ? { branchId: encounter.branchId } : {}),
    recordedAt,
  });

  return assess(created);
}

/** Every reading on a visit, oldest first, each assessed. */
export async function listForEncounter(encounterId: string): Promise<AssessedVitals[]> {
  const readings = await repo.forEncounter(encounterId);
  return readings.map(assess);
}

/** This patient's recent readings across visits, newest first, each assessed. */
export async function listForPatient(patientId: string, limit?: number): Promise<AssessedVitals[]> {
  const readings = await repo.forPatient(patientId, limit);
  return readings.map(assess);
}

/** The newest reading per encounter — for a queue or worklist column. */
export async function latestForEncounters(
  encounterIds: string[],
): Promise<Record<string, AssessedVitals>> {
  const latest = await repo.latestForEncounters(encounterIds);
  const out: Record<string, AssessedVitals> = {};
  for (const [encounterId, reading] of latest) out[encounterId] = assess(reading);
  return out;
}
