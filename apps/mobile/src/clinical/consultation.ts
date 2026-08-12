/**
 * The consultation note as a FORM — what changed, and what to send.
 *
 * ── THE PUT IS A PATCH IN DISGUISE, AND THAT MATTERS ────────────────────────
 * `saveConsultation` touches only the fields present in the body: "a blank string / empty list
 * clears one" (api-client). So sending the whole form on every save is not harmless — it means a
 * doctor who opens a note written by a colleague, types one line into `plan`, and saves, would
 * re-send `examination` exactly as they received it. Usually identical, occasionally not: if the
 * colleague saved a longer examination in the seconds since this screen loaded, the resend
 * silently overwrites it with the stale copy. Sending only what THIS doctor edited turns a
 * last-write-wins overwrite into a field-level merge, for free.
 *
 * ── AND IT IS WHAT MAKES "DIRTY" HONEST ─────────────────────────────────────
 * The same comparison answers "are there unsaved changes?". One function, so the banner and the
 * payload can never disagree — a screen that warned about unsaved work and then sent nothing, or
 * saved silently while claiming to be clean, would be worse than either alone.
 *
 * ── NO VALIDATION HERE ──────────────────────────────────────────────────────
 * Lengths, the 20-diagnosis cap, the "nothing to save" refusal: all server-side, all in
 * `consultation.schema.ts`, none re-implemented. A second copy of a rule drifts, and the copy
 * that drifts is always the one that silently allows less than the server does — a doctor
 * refused by their own phone for a note the hospital would have accepted.
 */
import type { ConsultationNote, Diagnosis } from "@medicore/api-client";

/** Exactly the fields `PUT /encounters/:id/consultation` accepts. Nothing invented. */
export interface ConsultationForm {
  chiefComplaint: string;
  history: string;
  examination: string;
  plan: string;
  diagnoses: Diagnosis[];
  /** Empty string when unset — a text input's natural value. Converted on the way out. */
  followUpDays: string;
}

export const EMPTY_FORM: ConsultationForm = {
  chiefComplaint: "",
  history: "",
  examination: "",
  plan: "",
  diagnoses: [],
  followUpDays: "",
};

/** The server's note as a form. `null` (no note started yet) is an empty one, not an error. */
export function formFrom(note: ConsultationNote | null | undefined): ConsultationForm {
  if (!note) return { ...EMPTY_FORM, diagnoses: [] };
  return {
    chiefComplaint: note.chiefComplaint ?? "",
    history: note.history ?? "",
    examination: note.examination ?? "",
    plan: note.plan ?? "",
    diagnoses: note.diagnoses.map((d) => ({ ...d })),
    followUpDays: note.followUpDays === undefined ? "" : String(note.followUpDays),
  };
}

function sameDiagnoses(a: readonly Diagnosis[], b: readonly Diagnosis[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return (
      right !== undefined &&
      left.text === right.text &&
      left.type === right.type &&
      (left.code ?? "") === (right.code ?? "")
    );
  });
}

export type ConsultationField = keyof ConsultationForm;

/** Which fields the user actually changed, against the note as it was loaded. */
export function changedFields(
  original: ConsultationForm,
  current: ConsultationForm,
): ConsultationField[] {
  const changed: ConsultationField[] = [];
  for (const field of [
    "chiefComplaint",
    "history",
    "examination",
    "plan",
    "followUpDays",
  ] as const) {
    if (original[field] !== current[field]) changed.push(field);
  }
  if (!sameDiagnoses(original.diagnoses, current.diagnoses)) changed.push("diagnoses");
  return changed;
}

export function isDirty(original: ConsultationForm, current: ConsultationForm): boolean {
  return changedFields(original, current).length > 0;
}

/** What `saveConsultation` takes. Only the edited fields — see the header. */
export type ConsultationPatch = Parameters<
  (input: {
    chiefComplaint?: string;
    history?: string;
    examination?: string;
    diagnoses?: Diagnosis[];
    plan?: string;
    followUpDays?: number;
  }) => void
>[0];

/**
 * The body for a save, or `undefined` when nothing changed.
 *
 * `undefined` is not a quirk — the server refuses an empty PUT with "nothing to save", so a screen
 * that sent one on an untouched form would turn a no-op into a validation error the doctor cannot
 * act on. The Save button is disabled in that state; this is the second lock.
 *
 * A cleared `followUpDays` sends `0` rather than being omitted: omitting it would LEAVE the old
 * value, and "I deleted the follow-up and it came back" is a real appointment nobody books.
 */
export function patchFor(
  original: ConsultationForm,
  current: ConsultationForm,
): ConsultationPatch | undefined {
  const changed = changedFields(original, current);
  if (changed.length === 0) return undefined;

  const patch: ConsultationPatch = {};
  if (changed.includes("chiefComplaint")) patch.chiefComplaint = current.chiefComplaint.trim();
  if (changed.includes("history")) patch.history = current.history.trim();
  if (changed.includes("examination")) patch.examination = current.examination.trim();
  if (changed.includes("plan")) patch.plan = current.plan.trim();
  if (changed.includes("diagnoses")) patch.diagnoses = current.diagnoses;
  if (changed.includes("followUpDays")) {
    const parsed = Number.parseInt(current.followUpDays, 10);
    patch.followUpDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return patch;
}

/** Adding a diagnosis. Provisional by default — a final one is a decision, not a default. */
export function withDiagnosis(form: ConsultationForm, text: string): ConsultationForm {
  const trimmed = text.trim();
  if (trimmed.length === 0) return form;
  return { ...form, diagnoses: [...form.diagnoses, { text: trimmed, type: "provisional" }] };
}

export function withoutDiagnosis(form: ConsultationForm, index: number): ConsultationForm {
  return { ...form, diagnoses: form.diagnoses.filter((_, i) => i !== index) };
}

export function withDiagnosisType(
  form: ConsultationForm,
  index: number,
  type: Diagnosis["type"],
): ConsultationForm {
  return {
    ...form,
    diagnoses: form.diagnoses.map((d, i) => (i === index ? { ...d, type } : d)),
  };
}
