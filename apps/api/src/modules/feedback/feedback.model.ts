/**
 * Feedback & complaints (Module B10, Doc 02 B-group support).
 *
 * ── WHAT B10 IS ─────────────────────────────────────────────────────────────
 * One register for the two things a patient or visitor tells a hospital about itself: a
 * COMPLIMENT or suggestion (`feedback`) and a grievance (`complaint`). They share a shape — a
 * subject, who raised it, how it arrived, and what was done about it — so they are one ticket with
 * a `kind`, not two collections. A complaint carries a `severity`; feedback carries a `rating`.
 *
 * ── THE LIFECYCLE IS THE POINT ──────────────────────────────────────────────
 * A complaint that is logged and never worked is worse than none — it told the patient someone was
 * listening and then proved otherwise. So a ticket moves through a small state machine
 * (open → in_progress → resolved → closed, with a resolved ticket re-openable), every move is
 * appended to `statusHistory` with who and why, and resolving REQUIRES a note — "resolved" with no
 * account of how is not a resolution. `transition()` is the only door, exactly as appointments and
 * ambulance trips do it.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** A compliment/suggestion, or a grievance. Drives which of rating/severity applies. */
export const FEEDBACK_KINDS = ["feedback", "complaint"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** What it is about — groups the register and routes it to the right desk. */
export const FEEDBACK_CATEGORIES = [
  "service",
  "staff",
  "billing",
  "cleanliness",
  "food",
  "waiting_time",
  "clinical",
  "facilities",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** How it reached the hospital. */
export const FEEDBACK_CHANNELS = [
  "in_person",
  "phone",
  "email",
  "web",
  "suggestion_box",
  "other",
] as const;
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

/** How serious a complaint is — the triage that decides what gets worked first. */
export const COMPLAINT_SEVERITIES = ["low", "medium", "high"] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];

export const FEEDBACK_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

const TRANSITIONS: Record<FeedbackStatus, FeedbackStatus[]> = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "closed"],
  // A "resolved" ticket the patient says is not fixed re-opens; otherwise it closes.
  resolved: ["closed", "in_progress"],
  closed: [],
};

export function canTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface FeedbackStatusChange {
  from: FeedbackStatus;
  to: FeedbackStatus;
  at: Date;
  by?: string;
  note?: string;
}

export interface FeedbackTicketDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  kind: FeedbackKind;
  category: FeedbackCategory;
  channel: FeedbackChannel;
  subject: string;
  description: string;

  /** The registered patient this concerns, when one is linked — opaque, kept for cross-reference. */
  patientId?: string;
  /** Who raised it, for a walk-in/visitor with no chart. Free text. */
  reporterName?: string;
  reporterPhone?: string;

  /** Feedback only — a 1–5 satisfaction score. */
  rating?: number;
  /** Complaint only — triage severity. */
  severity?: ComplaintSeverity;

  status: FeedbackStatus;
  /** The staff user working it — an opaque user id, like `appointment.doctorId`. */
  assignedTo?: string;
  /** How it was resolved — set when the ticket reaches `resolved`. */
  resolutionNote?: string;

  statusHistory: FeedbackStatusChange[];
  createdBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const feedbackTicketSchema = new Schema<FeedbackTicketDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    kind: { type: String, enum: FEEDBACK_KINDS, required: true, default: "feedback" },
    category: { type: String, enum: FEEDBACK_CATEGORIES, required: true, default: "other" },
    channel: { type: String, enum: FEEDBACK_CHANNELS, required: true, default: "in_person" },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },

    patientId: { type: String },
    reporterName: { type: String, trim: true, maxlength: 120 },
    reporterPhone: { type: String, trim: true, maxlength: 20 },

    rating: { type: Number, min: 1, max: 5 },
    severity: { type: String, enum: COMPLAINT_SEVERITIES },

    status: { type: String, enum: FEEDBACK_STATUSES, required: true, default: "open" },
    assignedTo: { type: String },
    resolutionNote: { type: String, trim: true, maxlength: 2000 },

    statusHistory: {
      type: [
        new Schema<FeedbackStatusChange>(
          {
            from: { type: String, required: true },
            to: { type: String, required: true },
            at: { type: Date, required: true },
            by: { type: String },
            note: { type: String },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    createdBy: { type: String },
  },
  // Indexes owned by migration 0037, never autoIndex — see the patient model.
  { timestamps: true, collection: "feedbackTickets", autoIndex: false },
);

feedbackTicketSchema.plugin(tenantScopePlugin);

// A ticket names a person and may recount a clinical grievance — that is PHI, like an ambulance
// trip. The status history is operational noise, not a fact about the patient.
feedbackTicketSchema.plugin(auditPlugin, {
  resource: "feedbackTicket",
  category: "phi",
  ignore: ["statusHistory"],
});

export function getFeedbackTicketModel(conn: Connection): Model<FeedbackTicketDoc> {
  return (
    (conn.models.FeedbackTicket as Model<FeedbackTicketDoc>) ??
    conn.model<FeedbackTicketDoc>("FeedbackTicket", feedbackTicketSchema)
  );
}
