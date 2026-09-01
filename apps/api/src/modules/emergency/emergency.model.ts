/**
 * Emergency department (D10) — the triage record, and nothing else.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
 * It is not a second patient model, a second encounter, or a second clinical lifecycle. An ED
 * arrival is an ENCOUNTER — `origin: "emergency"`, `class: "ER"` — and both of those already
 * existed in `encounter.model.ts` before this module did. The state machine an ED patient walks is
 * the encounter's own:
 *
 *   arrived ──▶ in_queue ──▶ in_progress ──▶ awaiting_results ──▶ closed
 *                                        └────────────────────▶ admitted
 *
 * which is exactly "arrived → triaged → with a doctor → treatment → disposition" wearing the names
 * the rest of the hospital already uses. Inventing an ED-specific copy of it would mean two
 * lifecycles for one patient, and the board would be a report on whichever of them was written to
 * last.
 *
 * ── SO WHAT IS ACTUALLY HERE ────────────────────────────────────────────────
 * The one thing the encounter cannot carry: **how sick they are, decided by a person, at a stated
 * time.** Priority is not a property of arriving — it is a clinical judgement made after arriving,
 * by someone accountable for it, and it can be revised. That is a record, so it is a collection —
 * one row per ED encounter, keyed on the encounter, exactly as `consultations` hangs one note on
 * one visit.
 *
 * Plus the one disposition the encounter has no word for: a patient sent to ANOTHER HOSPITAL.
 * `closed` says the visit ended; it does not say the patient left in an ambulance for a facility
 * with a cath lab, and that is the single most important line in the record when it happens.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * Three levels, deliberately.
 *
 * Five-level scales (ESI, Manchester, CTAS) are real and are what a teaching hospital uses, but
 * they are TRAINED instruments — a nurse who has not been taught the algorithm produces noise on a
 * five-point scale, and noise ranked by number looks exactly like signal. Three levels ask a
 * question anybody at an ED door can answer honestly: does this person need someone NOW, SOON, or
 * can they wait? A hospital that outgrows it is a hospital that has trained its staff on a scale,
 * and adding one then is a data migration on a column, not a redesign.
 */
export const TRIAGE_PRIORITIES = ["critical", "urgent", "non_urgent"] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

/**
 * How the board orders one patient against another. Lower is seen sooner.
 *
 * ── AND WHY "NOT TRIAGED YET" IS RANK ZERO ──────────────────────────────────
 * An untriaged patient's priority is not low — it is UNKNOWN, and the failure mode that kills
 * people in waiting rooms is unknown being treated as low. Somebody who walked in two minutes ago
 * and has not been looked at is precisely the person the triage nurse must see next, so they sort
 * above every patient whose severity has already been established. This is a number rather than a
 * sort on the word for the same reason `order.priorityRank` is: sorted alphabetically, `critical`
 * would fall below `non_urgent`.
 */
export const PRIORITY_RANK: Record<TriagePriority, number> = {
  critical: 1,
  urgent: 2,
  non_urgent: 3,
};
export const UNTRIAGED_RANK = 0;

export interface EdTriageDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** The ED visit this judgement is about — UNIQUE, one triage record per encounter. */
  encounterId: Types.ObjectId;
  patientId: Types.ObjectId;

  /**
   * ABSENT until somebody assesses the patient — and that absence is meaningful, not a gap to be
   * filled with a default. A row can exist with no priority at all: a crash victim diverted to a
   * trauma centre on sight is recorded (below) before anyone found time to triage them, and
   * stamping them `non_urgent` to satisfy a schema would be inventing a clinical judgement nobody
   * made. An absent priority sorts to the TOP of the board (`UNTRIAGED_RANK`).
   */
  priority?: TriagePriority;
  /** What the patient says is wrong, in their words. */
  chiefComplaint?: string;

  /** When the judgement was last made, and by whom. Re-triage overwrites both. */
  triagedAt?: Date;
  triagedBy?: string;

  /** Set only when the patient was sent to another facility. See the header. */
  transferredTo?: string;
  transferNote?: string;
  transferredAt?: Date;
  transferredBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const edTriageSchema = new Schema<EdTriageDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    encounterId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: Schema.Types.ObjectId, required: true },

    priority: { type: String, enum: TRIAGE_PRIORITIES },
    chiefComplaint: { type: String, trim: true, maxlength: 500 },

    triagedAt: { type: Date },
    triagedBy: { type: String },

    transferredTo: { type: String, trim: true, maxlength: 200 },
    transferNote: { type: String, trim: true, maxlength: 1000 },
    transferredAt: { type: Date },
    transferredBy: { type: String },
  },
  // Indexes owned by migration 0053, never autoIndex — see the patient model.
  { timestamps: true, collection: "edTriage", autoIndex: false },
);

edTriageSchema.plugin(tenantScopePlugin);
/**
 * PHI, and the audit trail IS the re-triage history.
 *
 * A patient downgraded from `critical` to `urgent` while they waited is a decision somebody has to
 * be able to account for, and `auditPlugin` already records every field change with its actor.
 * Storing a second history array beside it would be the same facts written twice, drifting.
 */
edTriageSchema.plugin(auditPlugin, { resource: "edTriage", category: "phi" });

export function getEdTriageModel(conn: Connection): Model<EdTriageDoc> {
  return (
    (conn.models.EdTriage as Model<EdTriageDoc>) ??
    conn.model<EdTriageDoc>("EdTriage", edTriageSchema)
  );
}
