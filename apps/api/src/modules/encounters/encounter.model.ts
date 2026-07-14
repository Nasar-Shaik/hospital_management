/**
 * Encounter — THE CENTRAL CLINICAL OBJECT (ADR-0013, STATE_MACHINE_CATALOG §14).
 *
 * One contact between a patient and the hospital, from arrival to departure. Every
 * note, order, result and charge will hang on exactly one of these.
 *
 * ── WHY THIS EXISTS AND APPOINTMENT DOES NOT SUFFICE ────────────────────────
 * The system was built appointment-first because appointments were built first.
 * Only ONE of our six target organization types is appointment-led (the private
 * hospital). A government hospital, a clinic and a diagnostic centre are WALK-IN
 * led: nothing is booked, and yet hundreds of patients a day pass through. Under
 * the old model they could not even be issued a token without fabricating an
 * appointment for them.
 *
 * So an Appointment is a PROMISE of a future encounter, and one `origin` among
 * many. The encounter begins on ARRIVAL — because that is the moment the hospital
 * starts owing the patient something.
 *
 * ── THE STATE THAT MATTERS MOST IS `awaiting_results` ───────────────────────
 * A patient sent to the lab walks out of the consulting room and comes back an hour
 * later. They keep the SAME encounter. Without a state for "gone, but still mine",
 * hospitals re-register the returning patient — which fragments one visit into two,
 * double-counts the census, and splits the bill across two records that no longer
 * add up. It is the commonest data-quality disaster in an OPD, and it is a
 * modelling failure, not a training failure.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/**
 * How the encounter came to exist (ADR-0013 §2).
 *
 * The queue does not care which of these it was — and that indifference IS the
 * architecture. A booked patient and a walk-in are the same thing once they are in
 * the building.
 */
export const ENCOUNTER_ORIGINS = [
  "appointment",
  "walk_in",
  "emergency",
  "referral",
  "camp",
  "telemedicine",
  "corporate",
  "transfer",
] as const;
export type EncounterOrigin = (typeof ENCOUNTER_ORIGINS)[number];

/** The care setting. FHIR calls this `class`. */
export const ENCOUNTER_CLASSES = ["OP", "IP", "ER", "TELE", "HOME"] as const;
export type EncounterClass = (typeof ENCOUNTER_CLASSES)[number];

export const ENCOUNTER_STATUSES = [
  "planned",
  "arrived",
  "in_queue",
  "in_progress",
  "awaiting_results",
  "closed",
  "cancelled",
  "left_without_being_seen",
  "admitted",
] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

/**
 * STATE_MACHINE_CATALOG §14, verbatim. The ONE graph that serves every
 * organization type — private, clinic, government, diagnostic centre.
 *
 * There is deliberately NO per-tenant workflow engine (ADR-0013 §5). The journeys
 * differ by five policy switches, not by shape. A configurable graph would be
 * "different codebases" hidden inside data, where CI cannot see it and no test can
 * cover it.
 */
export const TRANSITIONS: Record<EncounterStatus, readonly EncounterStatus[]> = {
  // Only an appointment starts here — a promise not yet kept. A walk-in is created
  // directly at `arrived`, and must NOT be dragged through a fake `planned`.
  planned: ["arrived", "cancelled"],
  arrived: ["in_queue", "in_progress", "cancelled", "left_without_being_seen"],
  in_queue: ["in_progress", "cancelled", "left_without_being_seen"],
  in_progress: ["awaiting_results", "closed", "admitted"],
  // The patient went to the lab and came back. SAME encounter — see the header.
  awaiting_results: ["in_progress", "closed", "admitted"],

  // Terminal.
  closed: [],
  cancelled: [],
  left_without_being_seen: [],
  // Terminal for THIS encounter — the care story continues in a new inpatient
  // encounter within the same Episode of Care (ADR-0013 §4). Continuity is a read
  // concern; separation is a billing and statutory one.
  admitted: [],
};

export function canTransition(from: EncounterStatus, to: EncounterStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Is this encounter still live — i.e. is the patient still the hospital's problem
 * right now?
 *
 * Used for the queue, for the "one open encounter per patient" guard, and (later)
 * for whether an order may still be placed against it.
 */
const OPEN: readonly EncounterStatus[] = [
  "planned",
  "arrived",
  "in_queue",
  "in_progress",
  "awaiting_results",
];

export function isOpen(status: EncounterStatus): boolean {
  return OPEN.includes(status);
}

/** The states that occupy a place in a queue and should appear on a queue board. */
const QUEUED: readonly EncounterStatus[] = ["in_queue", "in_progress", "awaiting_results"];
export function isQueued(status: EncounterStatus): boolean {
  return QUEUED.includes(status);
}

export interface EncounterHistoryEntry {
  from: EncounterStatus;
  to: EncounterStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface EncounterDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: Types.ObjectId;
  /** The care story this contact belongs to (ADR-0013 §4). */
  episodeId: Types.ObjectId;

  origin: EncounterOrigin;
  class: EncounterClass;
  status: EncounterStatus;

  /** Set only when the origin is an appointment — the promise this kept. */
  appointmentId?: Types.ObjectId;

  /**
   * Who the patient is waiting for. A named doctor (private, clinic) or a
   * DEPARTMENT / OP room (government) — `encounterPolicy.routing` decides which,
   * and at least one of them is always present.
   */
  doctorId?: string;
  departmentId?: string;

  /**
   * The number the patient is called by.
   *
   * IT LIVES HERE, NOT ON THE APPOINTMENT (ADR-0013). A walk-in has a token and no
   * appointment — in a government hospital that is not an edge case, it is every
   * single patient. Issued per the hospital's `tokenIssuedAt` policy: at
   * registration (government, clinic) or at check-in (private).
   */
  token?: number;

  reason?: string;

  /**
   * TRUE while the encounter is live. Derived from `status` — never set by hand.
   *
   * ── THIS FIELD IS AN INVARIANT, NOT A CONVENIENCE ───────────────────────────
   * A unique partial index on `{tenantId, patientId}` where `open === true`
   * (migration 0012) makes it IMPOSSIBLE for one patient to have two encounters
   * open at once. That is the database refusing to let a hospital do the single
   * commonest damaging thing in an OPD: re-register the patient who has come back
   * from the lab, fragmenting one visit into two that double-count the census and
   * split the bill.
   *
   * A boolean rather than `status: { $in: [...] }` because `partialFilterExpression`
   * cannot express `$in` — the same reason `appointments.occupies` exists. And
   * `default: undefined` so a CLOSED encounter carries no `open` key at all: a
   * stored `false` would still be indexed, and the patient could never come back.
   */
  open?: true;

  arrivedAt: Date;
  closedAt?: Date;

  createdBy?: string;
  history: EncounterHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const encounterSchema = new Schema<EncounterDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    patientId: { type: Schema.Types.ObjectId, required: true },
    episodeId: { type: Schema.Types.ObjectId, required: true },

    origin: { type: String, enum: ENCOUNTER_ORIGINS, required: true },
    class: { type: String, enum: ENCOUNTER_CLASSES, required: true, default: "OP" },
    status: { type: String, enum: ENCOUNTER_STATUSES, required: true, default: "arrived" },

    appointmentId: { type: Schema.Types.ObjectId },

    doctorId: { type: String },
    departmentId: { type: String },

    token: { type: Number },
    reason: { type: String, trim: true, maxlength: 500 },

    // `default: undefined`, never `false` — see the interface. A stored `false`
    // would sit in the unique index and lock the patient out of ever returning.
    open: { type: Boolean, default: undefined },

    arrivedAt: { type: Date, required: true },
    closedAt: { type: Date },

    createdBy: { type: String },
    history: [
      {
        _id: false,
        from: { type: String, required: true },
        to: { type: String, required: true },
        at: { type: Date, required: true },
        by: { type: String },
        reason: { type: String },
      },
    ],
  },
  { timestamps: true, collection: "encounters", autoIndex: false },
);

encounterSchema.plugin(tenantScopePlugin);
// PHI: an encounter says a named person was in a hospital on a date, which is a
// disclosure in itself.
encounterSchema.plugin(auditPlugin, { resource: "encounter", category: "phi" });

/**
 * Episode of Care — the container that links related encounters into ONE care story
 * (ADR-0013 §4).
 *
 * This is what makes "the admission automatically inherits the OP consultation, its
 * investigations and its prescriptions" true: the admission is a NEW encounter in
 * the SAME episode, and the doctor's timeline is a read over the episode.
 *
 * We do NOT extend the OP encounter through the admission. OP and IP tariffs
 * differ, bed charges accrue per day, and census/ALOS/NABH all count encounters.
 * Two encounters can always be joined into a timeline; one encounter can never be
 * split back apart once notes and charges have accumulated on it.
 */
export const EPISODE_STATUSES = ["active", "closed"] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

export interface EpisodeDoc {
  _id: Types.ObjectId;
  tenantId: string;
  patientId: Types.ObjectId;
  status: EpisodeStatus;
  /** Why this care story exists — "fever", "fracture follow-up". Free text for now. */
  reason?: string;
  startedAt: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const episodeSchema = new Schema<EpisodeDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: EPISODE_STATUSES, required: true, default: "active" },
    reason: { type: String, trim: true, maxlength: 500 },
    startedAt: { type: Date, required: true },
    closedAt: { type: Date },
  },
  { timestamps: true, collection: "episodesOfCare", autoIndex: false },
);

episodeSchema.plugin(tenantScopePlugin);
episodeSchema.plugin(auditPlugin, { resource: "episodeOfCare", category: "phi" });

export function getEncounterModel(conn: Connection): Model<EncounterDoc> {
  return (
    (conn.models.Encounter as Model<EncounterDoc>) ??
    conn.model<EncounterDoc>("Encounter", encounterSchema)
  );
}

export function getEpisodeModel(conn: Connection): Model<EpisodeDoc> {
  return (
    (conn.models.EpisodeOfCare as Model<EpisodeDoc>) ??
    conn.model<EpisodeDoc>("EpisodeOfCare", episodeSchema)
  );
}
