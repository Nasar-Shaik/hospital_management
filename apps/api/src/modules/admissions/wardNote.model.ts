/**
 * Ward notes — the daily record of an admission, and the summary it ends with.
 *
 * ── WHY THIS IS NOT "THE EMR" ───────────────────────────────────────────────
 * It is the narrow, honest slice of clinical documentation an ADMISSION cannot exist
 * without: what happened today, and what to tell the patient on the way out. A real EMR
 * brings structured vitals, problem lists, coded diagnoses, templates and signing —
 * `emr:write` and `emr:sign` are permissions today with nothing behind them.
 *
 * Notes hang off the ENCOUNTER, never off the admission-as-an-object, because there is no
 * admission object: the IP encounter IS the admission (ADR-0013 §1).
 *
 * ── A NOTE IS IMMUTABLE ─────────────────────────────────────────────────────
 * There is no update path and no delete path in the repository, and that is the design.
 * A ward note is a contemporaneous record of what somebody observed at a moment; a record
 * that can be rewritten afterwards is not evidence of anything, and the first question at
 * an inquest is whether the notes were changed after the event. A correction is a NEW note
 * that says so — which is exactly how the paper chart works, and why it is still trusted.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * `progress` — the daily entry: how the patient is, what changed, what is planned.
 * `discharge_summary` — the document the patient goes home with. Exactly one per
 * admission, written as they leave: diagnosis, what we did, what to take, when to come
 * back. It is the ONLY thing the next doctor to see this patient is likely to read, and
 * for a patient who goes back to a village clinic it is the entire medical record of the
 * stay.
 * `outcome_note` — the record of a NON-routine ending: LAMA, absconded, or a death. A
 * routine discharge gets a summary; these get the account of what happened instead — the
 * risks explained before a patient left against advice, when an absence was discovered, or
 * the circumstances of a death. Statutorily it is the note that matters most, so the
 * outcome path writes it and cannot skip it.
 * `nursing` — the bedside entry (M3-S2): what the nurse observed, did and handed over. A
 * distinct TYPE rather than a distinct collection, so the chart stays one chronological
 * record — a doctor reading the stay sees the nursing entries in the same feed, which is the
 * whole point of a ward round. It has its own creation route and its own permission
 * (`nursing:manage`), because writing a nursing entry and writing a discharge summary are
 * different responsibilities held by different people.
 */
export const WARD_NOTE_TYPES = [
  "progress",
  "discharge_summary",
  "outcome_note",
  "nursing",
] as const;
export type WardNoteType = (typeof WARD_NOTE_TYPES)[number];

export interface WardNoteDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The INPATIENT encounter. Required — a ward note with no admission is not a thing. */
  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;
  /** The care story, so the summary survives into the patient's next visit. */
  episodeId: Types.ObjectId;

  type: WardNoteType;
  text: string;

  /** Discharge summaries only. Free text: there is no coded diagnosis list yet. */
  diagnosis?: string;
  /** Discharge summaries only — "what to do at home", the half patients actually follow. */
  advice?: string;
  followUpOn?: Date;

  /** Who wrote it. From the authenticated caller: a note is a signature, in effect. */
  authorId: string;
  at: Date;

  createdAt: Date;
  updatedAt: Date;
}

const wardNoteSchema = new Schema<WardNoteDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    type: { type: String, enum: WARD_NOTE_TYPES, required: true, default: "progress" },
    text: { type: String, required: true, trim: true, maxlength: 20_000 },

    diagnosis: { type: String, trim: true, maxlength: 1000 },
    advice: { type: String, trim: true, maxlength: 5000 },
    followUpOn: { type: Date },

    authorId: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { timestamps: true, collection: "wardNotes", autoIndex: false },
);

wardNoteSchema.plugin(tenantScopePlugin);
/**
 * PHI, and the richest kind: a progress note is free text about a human being written by
 * somebody who is not thinking about data protection at 3am. `text`, `diagnosis` and
 * `advice` are excluded from the audit diff for the same reason `orders.result` and
 * `prescriptions.lines` are — the audit log records THAT the chart was touched, and must
 * never become a second copy of the chart behind weaker access controls than the chart.
 */
wardNoteSchema.plugin(auditPlugin, {
  resource: "wardNote",
  category: "phi",
  ignore: ["text", "diagnosis", "advice"],
});

export function getWardNoteModel(conn: Connection): Model<WardNoteDoc> {
  return (
    (conn.models.WardNote as Model<WardNoteDoc>) ??
    conn.model<WardNoteDoc>("WardNote", wardNoteSchema)
  );
}
