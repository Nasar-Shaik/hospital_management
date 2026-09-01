/**
 * Typing a set of observations (M3-S4) — the nurse's first clinical write.
 *
 * ── WHAT THIS FILE IS ALLOWED TO DECIDE, AND WHAT IT IS NOT ─────────────────
 * It parses what was typed, says whether it is a plausible measurement, and assembles the payload.
 * It does NOT decide whether a value is clinically abnormal. That word belongs to the server's
 * `assess()` — the reference ranges live in exactly one place and `clinical/vitals.ts` already
 * exists to render the result. A phone with its own opinion about a pulse of 55 is a second
 * opinion nobody reviewed, and it would disagree with the web app on the same patient.
 *
 * The line between the two is precise, and worth stating because it is easy to blur:
 *
 *     plausible   → "this could be a measurement"        decided here, to catch a typo
 *     normal      → "this is within the reference range"  decided by the API, and only shown after
 *
 * A systolic of 250 is IMPLAUSIBLE to nobody: it is a hypertensive emergency and must chart
 * without a fight. 2500 is a slipped finger. That is the only distinction drawn here, and it is
 * the same one the server's own schema draws — the bounds below are copied FROM it, and a test
 * pins them together so they cannot drift apart silently.
 *
 * ── NOTHING IS EVER CLAMPED, CORRECTED OR ROUNDED AWAY ──────────────────────
 * If a nurse types 350 the app says "check this figure" and keeps 350 on screen. It does not save
 * 300, and it does not blank the box. Silently adjusting a clinical measurement is the worst
 * possible behaviour here: it produces a chart nobody typed, and the person who would have caught
 * it is the one whose entry was changed.
 */
import { VITAL_FIELDS, type RecordVitalsInput, type VitalField } from "@medicore/api-client";

/** What the nurse has typed, as strings — the form's own state. */
export type VitalsDraft = Partial<Record<VitalField, string>> & {
  triageLevel?: "routine" | "urgent" | "critical";
  notes?: string;
};

interface FieldRule {
  label: string;
  unit: string;
  /** The server's own plausibility bounds. Mirrored, and pinned by a test. */
  min: number;
  max: number;
  /** `false` where the server takes `z.number().int()` — a pulse of 72.5 is not a reading. */
  decimals: boolean;
}

/**
 * Label, unit and bounds per field.
 *
 * `Record<VitalField, …>` rather than a partial: a field added to the API and forgotten here is a
 * COMPILE error rather than a box that quietly never appears on the nurse's form.
 */
export const FIELD_RULES: Record<VitalField, FieldRule> = {
  systolic: { label: "BP systolic", unit: "mmHg", min: 40, max: 300, decimals: false },
  diastolic: { label: "BP diastolic", unit: "mmHg", min: 20, max: 200, decimals: false },
  pulse: { label: "Pulse", unit: "bpm", min: 20, max: 300, decimals: false },
  respiratoryRate: { label: "Respiratory rate", unit: "/min", min: 4, max: 90, decimals: false },
  temperature: { label: "Temperature", unit: "°C", min: 25, max: 45, decimals: true },
  spo2: { label: "SpO₂", unit: "%", min: 40, max: 100, decimals: false },
  weightKg: { label: "Weight", unit: "kg", min: 0.3, max: 500, decimals: true },
  heightCm: { label: "Height", unit: "cm", min: 20, max: 260, decimals: true },
  painScore: { label: "Pain score", unit: "/10", min: 0, max: 10, decimals: false },
};

/**
 * The order the form asks in — the order a nurse takes them at the bedside.
 *
 * BP and pulse first because they are what a routine observation round is FOR; height last
 * because it is measured once an admission and then never again. `VITAL_FIELDS` (the chart's
 * reading order) happens to agree today, and this is stated separately anyway: the order you
 * write in and the order you read in are different questions and should be free to diverge.
 */
export const ENTRY_ORDER: readonly VitalField[] = [
  "systolic",
  "diastolic",
  "pulse",
  "spo2",
  "temperature",
  "respiratoryRate",
  "painScore",
  "weightKg",
  "heightCm",
];

export interface FieldProblem {
  field: VitalField;
  message: string;
}

/** A parsed draft: the numbers to send, and everything that could not be read as one. */
export interface ParsedDraft {
  values: Partial<Record<VitalField, number>>;
  problems: FieldProblem[];
  /** True when nothing at all was entered — a different message from "one box is wrong". */
  empty: boolean;
}

/**
 * Read the boxes.
 *
 * A blank box is NOT zero and never becomes one. Blank means "not measured", and the field is
 * omitted from the payload entirely — sending `pulse: 0` would chart a cardiac arrest.
 */
export function parseDraft(draft: VitalsDraft): ParsedDraft {
  const values: Partial<Record<VitalField, number>> = {};
  const problems: FieldProblem[] = [];

  for (const field of ENTRY_ORDER) {
    const raw = draft[field]?.trim();
    if (raw === undefined || raw === "") continue;

    const rule = FIELD_RULES[field];
    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) {
      problems.push({ field, message: `${rule.label} must be a number.` });
      continue;
    }
    if (!rule.decimals && !Number.isInteger(parsed)) {
      problems.push({ field, message: `${rule.label} is recorded in whole ${rule.unit}.` });
      continue;
    }
    if (parsed < rule.min || parsed > rule.max) {
      // The wording matters. "Check this figure" invites a second look at what was typed; "invalid"
      // invites deleting it, and a real 250 systolic must not get deleted because the app scolded.
      problems.push({
        field,
        message: `Check this figure — ${rule.label.toLowerCase()} is recorded between ${String(
          rule.min,
        )} and ${String(rule.max)} ${rule.unit}.`,
      });
      continue;
    }

    values[field] = parsed;
  }

  const empty = Object.keys(values).length === 0 && problems.length === 0;
  return { values, problems, empty };
}

/**
 * The one cross-field rule, and it is the server's: diastolic below systolic.
 *
 * Checked here as well as there because it is the commonest vitals entry error there is — the two
 * figures typed into the wrong boxes — and catching it before the round trip means the nurse fixes
 * it while the cuff is still in their hand. The SERVER still refuses it; this only saves a trip.
 */
export function bloodPressureProblem(
  values: Partial<Record<VitalField, number>>,
): FieldProblem | undefined {
  const { systolic, diastolic } = values;
  if (systolic === undefined || diastolic === undefined) return undefined;
  if (diastolic < systolic) return undefined;
  return {
    field: "diastolic",
    message:
      "Diastolic must be lower than systolic — check the two figures are the right way round.",
  };
}

/** Every problem the phone can see, in field order. The server may still find more. */
export function problemsFor(draft: VitalsDraft): FieldProblem[] {
  const parsed = parseDraft(draft);
  const bp = bloodPressureProblem(parsed.values);
  return bp ? [...parsed.problems, bp] : parsed.problems;
}

/** Problems indexed by field, in the `string[]` shape `TextField` already renders. */
export function problemsByField(
  problems: readonly FieldProblem[],
): Partial<Record<VitalField, string[]>> {
  const out: Partial<Record<VitalField, string[]>> = {};
  for (const problem of problems) {
    (out[problem.field] ??= []).push(problem.message);
  }
  return out;
}

/**
 * Is this worth sending?
 *
 * Mirrors the server's rule exactly — at least one measurement OR a triage level — rather than
 * requiring a full set. A nurse who could only get a pulse on a distressed patient must be able
 * to chart the pulse; demanding nine numbers produces either a refused save or invented ones, and
 * invented numbers in a chart are far worse than gaps.
 */
export function canSubmit(draft: VitalsDraft): boolean {
  const parsed = parseDraft(draft);
  if (problemsFor(draft).length > 0) return false;
  return Object.keys(parsed.values).length > 0 || draft.triageLevel !== undefined;
}

/** True once anything at all has been typed — what the unsaved-changes guard watches. */
export function isDirty(draft: VitalsDraft): boolean {
  const typed = ENTRY_ORDER.some((field) => (draft[field]?.trim() ?? "") !== "");
  return typed || draft.triageLevel !== undefined || (draft.notes?.trim() ?? "") !== "";
}

/**
 * The payload.
 *
 * Only fields that parsed cleanly, only a trimmed non-empty note. Nothing is defaulted and nothing
 * is inferred — in particular `recordedAt` is NOT sent, so the observation is stamped by the
 * server's clock rather than the handset's. The API accepts a `recordedAt` for catching a paper
 * chart up at a desk; a phone at the bedside is recording now, and offering a time picker there
 * would let a wrong device clock backdate a real observation.
 */
export function toPayload(draft: VitalsDraft): RecordVitalsInput {
  const { values } = parseDraft(draft);
  const notes = draft.notes?.trim();
  return {
    ...values,
    ...(draft.triageLevel ? { triageLevel: draft.triageLevel } : {}),
    ...(notes ? { notes } : {}),
  };
}

export interface ReviewLine {
  label: string;
  /** The value as it will be sent, with its unit — never a bare number. */
  value: string;
}

/**
 * What the nurse confirms before it becomes a permanent record.
 *
 * ── THE REVIEW SHOWS THE PAYLOAD, NOT THE FORM ──────────────────────────────
 * These lines are built from `toPayload`, so what is confirmed is literally what will be sent. A
 * review rendered from the draft strings could show a value the payload drops (a box the parser
 * rejected, a stray space) and the nurse would be confirming something that never leaves the
 * phone. Units are on every line for the same reason they are on the chart: a number without its
 * unit is the oldest measurement error there is.
 */
export function reviewLines(draft: VitalsDraft): ReviewLine[] {
  const payload = toPayload(draft);
  const lines: ReviewLine[] = [];

  // BP is read as one figure — "120/80" — because that is how it is spoken and remembered. Split
  // into two labelled rows it is technically faithful and clinically alien.
  const { systolic, diastolic } = payload;
  if (systolic !== undefined && diastolic !== undefined) {
    lines.push({ label: "Blood pressure", value: `${String(systolic)}/${String(diastolic)} mmHg` });
  }

  for (const field of ENTRY_ORDER) {
    if (systolic !== undefined && diastolic !== undefined && isBloodPressure(field)) continue;
    const value = payload[field];
    if (value === undefined) continue;
    const rule = FIELD_RULES[field];
    lines.push({ label: rule.label, value: `${String(value)} ${rule.unit}`.trim() });
  }

  if (payload.triageLevel) lines.push({ label: "Priority", value: payload.triageLevel });
  if (payload.notes) lines.push({ label: "Note", value: payload.notes });

  return lines;
}

const isBloodPressure = (field: VitalField): boolean =>
  field === "systolic" || field === "diastolic";

/** Every measurable field the API knows, for the test that pins this form against the contract. */
export const KNOWN_FIELDS: readonly VitalField[] = VITAL_FIELDS;
