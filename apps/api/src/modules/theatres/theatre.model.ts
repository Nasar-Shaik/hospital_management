/**
 * Operation Theatres + their booking schedule (Module B5, Doc 02 D-group surgical).
 *
 * ── WHAT B5 IS, AND WHAT IT IS NOT ──────────────────────────────────────────
 * "OT / ICU / ER registries" — but ICU and ER are BEDS, and the bed inventory (B4) already models
 * them: `WARD_KINDS` carries `icu / nicu / picu / hdu / emergency`, so an ICU cot or an ER bay is a
 * ward+bed like any other, admitted and tracked on the encounter. What B4 did NOT cover is the
 * OPERATING ROOM — a theatre is not a bed (a patient is not admitted to it; a procedure is booked
 * on it for a window of time). That gap is this module: the theatres a hospital has, and the
 * procedures scheduled on them.
 *
 * ── THE COLLISION RULE, HONESTLY STATED ─────────────────────────────────────
 * Two procedures must not run in one theatre at once. A procedure has a DURATION (start..end), so
 * the rule is an OVERLAP, and an overlap of arbitrary windows is not something a unique index can
 * express — a unique key can only forbid an EXACT collision. So this module enforces the rule in
 * two layers, and is candid about which does what:
 *   1. The SERVICE rejects any booking whose window overlaps an existing occupying booking on the
 *      same theatre (`start < otherEnd && end > otherStart`). This is the real rule.
 *   2. A partial-unique index on `{tenantId, theatreId, scheduledStart}` is the RACE backstop: it
 *      makes the double-submit / retry case (two identical bookings at the same instant) impossible
 *      at the database, closing the read-then-write window the overlap check alone would leave. OT
 *      scheduling is a single-coordinator desk, so that is the only concurrency that realistically
 *      occurs; the honest statement is "overlap in the service, exact-collision in the database".
 *
 * `occupies` is the same derived boolean the appointment module uses (appointment.model.ts): the
 * partial index keys on its PRESENCE, so it is `true` while the booking holds the theatre and
 * absent once it releases it. Set in one place (`setStatus`), never by hand.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** The kind of procedure room — groups the list; drives nothing in code. */
export const THEATRE_KINDS = [
  "major_ot",
  "minor_ot",
  "cath_lab",
  "endoscopy",
  "labor_room",
] as const;
export type TheatreKind = (typeof THEATRE_KINDS)[number];

/** `active` takes new bookings; `inactive` is retired but its history is still readable. */
export const THEATRE_STATUSES = ["active", "inactive"] as const;
export type TheatreStatus = (typeof THEATRE_STATUSES)[number];

export interface TheatreDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** `OT-1`, `Cath Lab`. */
  name: string;
  /** Short code, unique per tenant — the human key on the board (`OT1`). */
  code: string;
  kind: TheatreKind;
  status: TheatreStatus;

  createdAt: Date;
  updatedAt: Date;
}

/* ── OT booking lifecycle (STATE_MACHINE_CATALOG-style, mirroring appointments) ── */

export const OT_BOOKING_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
export type OtBookingStatus = (typeof OT_BOOKING_STATUSES)[number];

const TRANSITIONS: Record<OtBookingStatus, OtBookingStatus[]> = {
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: OtBookingStatus, to: OtBookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which a booking HOLDS its theatre window. Terminal states release it. */
const OCCUPYING: OtBookingStatus[] = ["scheduled", "in_progress"];

export function occupiesTheatre(status: OtBookingStatus): boolean {
  return OCCUPYING.includes(status);
}

export interface OtStatusChange {
  from: OtBookingStatus;
  to: OtBookingStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface OtBookingDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  theatreId: Types.ObjectId;
  patientId: string;
  /** The operating surgeon — a staff user id. Trusted as an opaque id, like `appointment.doctorId`. */
  surgeonId: string;
  /** The clinical encounter this procedure belongs to, when there is one (ADR-0013). */
  encounterId?: Types.ObjectId;

  procedureName: string;
  scheduledStart: Date;
  scheduledEnd: Date;

  status: OtBookingStatus;
  /**
   * Derived from `status`. `undefined` (not `false`) when the window is free — the partial index
   * keys on the field's PRESENCE and a stored `false` would still be indexed (appointment.model.ts).
   */
  occupies?: true;

  notes?: string;
  statusHistory: OtStatusChange[];
  bookedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const theatreSchema = new Schema<TheatreDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    kind: { type: String, enum: THEATRE_KINDS, required: true, default: "major_ot" },
    status: { type: String, enum: THEATRE_STATUSES, required: true, default: "active" },
  },
  // Indexes owned by migration 0031, never autoIndex — see the patient model.
  { timestamps: true, collection: "theatres", autoIndex: false },
);

const otBookingSchema = new Schema<OtBookingDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    theatreId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: String, required: true },
    surgeonId: { type: String, required: true },
    encounterId: { type: Schema.Types.ObjectId },

    procedureName: { type: String, required: true, trim: true, maxlength: 200 },
    scheduledStart: { type: Date, required: true },
    scheduledEnd: { type: Date, required: true },

    status: { type: String, enum: OT_BOOKING_STATUSES, required: true, default: "scheduled" },
    // `default: undefined` is load-bearing: a materialized `false` would be indexed by the partial
    // index that keys on existence (PROJECT_MEMORY §8, appointment.model.ts).
    occupies: { type: Boolean, default: undefined },

    notes: { type: String, trim: true, maxlength: 1000 },
    statusHistory: {
      type: [
        new Schema<OtStatusChange>(
          {
            from: { type: String, required: true },
            to: { type: String, required: true },
            at: { type: Date, required: true },
            by: { type: String },
            reason: { type: String },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    bookedBy: { type: String },
  },
  { timestamps: true, collection: "otBookings", autoIndex: false },
);

theatreSchema.plugin(tenantScopePlugin);
otBookingSchema.plugin(tenantScopePlugin);

// A theatre is estate configuration — `admin`, like `wards`.
theatreSchema.plugin(auditPlugin, { resource: "theatre", category: "admin" });
// A booking says a named patient is having a named procedure on a date — that is PHI, like an
// appointment. `occupies` is an index key, not a fact about the patient; the history is noise.
otBookingSchema.plugin(auditPlugin, {
  resource: "otBooking",
  category: "phi",
  ignore: ["occupies", "statusHistory"],
});

export function getTheatreModel(conn: Connection): Model<TheatreDoc> {
  return (
    (conn.models.Theatre as Model<TheatreDoc>) ?? conn.model<TheatreDoc>("Theatre", theatreSchema)
  );
}

export function getOtBookingModel(conn: Connection): Model<OtBookingDoc> {
  return (
    (conn.models.OtBooking as Model<OtBookingDoc>) ??
    conn.model<OtBookingDoc>("OtBooking", otBookingSchema)
  );
}
