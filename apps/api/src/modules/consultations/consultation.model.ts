/**
 * Consultation note (Module D3 / EMR depth, ADR-0013).
 *
 * ── WHAT THIS DEEPENS ───────────────────────────────────────────────────────
 * Until now the doctor's whole record of a visit was two free-text lines on the encounter —
 * `diagnosis` and `advice` — enough to print an OPD slip and nothing more. A real consultation is
 * structured: the complaint that brought the patient, the history, what the examination found, the
 * DIAGNOSES (each a named condition, optionally coded), and the plan. This is that note — ONE per
 * encounter, the clinical heart of the visit.
 *
 * ── WHY DIAGNOSES ARE A LIST, EACH WITH A TYPE ──────────────────────────────
 * A visit rarely has exactly one diagnosis, and the ones it has are not equal: some are settled
 * (`final`), some are working guesses pending a test (`provisional`). Storing them as a typed list —
 * rather than a comma-joined string — is what later lets a report count "how many dengue cases this
 * month" and a bill attach the right package. The `code` is an ICD (or local) code, free-text for
 * now: the doctor types it if they know it; a coded master is a later unit, and the shape is ready
 * for it.
 *
 * ── THE OPD SLIP STAYS TRUTHFUL ─────────────────────────────────────────────
 * The encounter's `diagnosis`/`advice` still drive the printed slip. Saving this note DERIVES those
 * two lines from the structured content (the final diagnoses, the plan) and writes them back through
 * the encounter's own `recordVisitSummary`, so the slip a patient carries home never disagrees with
 * the record — one source, two renderings.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** `provisional` = a working diagnosis pending confirmation; `final` = settled. */
export const DIAGNOSIS_TYPES = ["provisional", "final"] as const;
export type DiagnosisType = (typeof DIAGNOSIS_TYPES)[number];

export interface Diagnosis {
  /** The condition, in words — always present (a code without a name is unreadable at the bedside). */
  text: string;
  /** ICD-10 / local code, when the doctor supplies one. Free-text for now. */
  code?: string;
  type: DiagnosisType;
}

export interface ConsultationNoteDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The visit this note belongs to — UNIQUE, one note per encounter. */
  encounterId: Types.ObjectId;
  patientId: string;
  /** The doctor who authored it — an opaque user id, like `encounter.doctorId`. */
  doctorId?: string;

  chiefComplaint?: string;
  /** History of the presenting illness — the story of what brought them in. */
  history?: string;
  examination?: string;
  diagnoses: Diagnosis[];
  plan?: string;
  /** Days until the doctor wants them back — the clinical instruction, as the doctor types it. */
  followUpDays?: number;
  /**
   * The DAY that instruction lands on — `2026-08-30` — derived once from `followUpDays`.
   *
   * ── WHY THE DATE IS STORED AND NOT DERIVED ON READ ──────────────────────────
   * "Come back in 7 days" is only meaningful next to a date, and the date depends on the site's
   * clock. Deriving it per read would mean resolving a branch timezone on every row of a
   * worklist, and — worse — the naive anchor is `updatedAt`, which MOVES every time the doctor
   * re-saves the note. A follow-up that slides forward each time the plan is edited is a
   * follow-up nobody is ever chased for. The service anchors on the ENCOUNTER's `arrivedAt`
   * instead, which never moves, so the answer is stable however often the note is written.
   *
   * A `YYYY-MM-DD` STRING, not a Date, for the reason `doctorLeave.fromDate` gives: a whole-day
   * fact in the site's own reckoning has no timezone to shift under it, so "due on the 30th"
   * cannot become the 29th for a reader in another zone. (`wardNotes.followUpOn` — the discharge
   * summary's equivalent — is a Date; that is a separate surface and is not touched here.)
   *
   * Absent when the doctor asked for no follow-up. Clearing `followUpDays` clears this with it.
   */
  followUpOn?: string;

  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const diagnosisSchema = new Schema<Diagnosis>(
  {
    text: { type: String, required: true, trim: true, maxlength: 300 },
    code: { type: String, trim: true, maxlength: 32 },
    type: { type: String, enum: DIAGNOSIS_TYPES, required: true, default: "provisional" },
  },
  { _id: false },
);

const consultationNoteSchema = new Schema<ConsultationNoteDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: String, required: true },
    doctorId: { type: String },

    chiefComplaint: { type: String, trim: true, maxlength: 1000 },
    history: { type: String, trim: true, maxlength: 4000 },
    examination: { type: String, trim: true, maxlength: 4000 },
    diagnoses: { type: [diagnosisSchema], default: undefined },
    plan: { type: String, trim: true, maxlength: 4000 },
    followUpDays: { type: Number, min: 0, max: 3650 },
    followUpOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

    updatedBy: { type: String },
  },
  // Indexes owned by migration 0039, never autoIndex — see the patient model.
  { timestamps: true, collection: "consultationNotes", autoIndex: false },
);

consultationNoteSchema.plugin(tenantScopePlugin);

// The clinical content of a visit — PHI, like the encounter it belongs to.
consultationNoteSchema.plugin(auditPlugin, { resource: "consultationNote", category: "phi" });

export function getConsultationNoteModel(conn: Connection): Model<ConsultationNoteDoc> {
  return (
    (conn.models.ConsultationNote as Model<ConsultationNoteDoc>) ??
    conn.model<ConsultationNoteDoc>("ConsultationNote", consultationNoteSchema)
  );
}
