/**
 * Ambulance fleet + the trips dispatched on it (Module B6, Doc 02 B-group facility).
 *
 * ── WHAT B6 IS ──────────────────────────────────────────────────────────────
 * The vehicles a hospital runs and the trips it sends them on: an emergency pickup, an
 * inter-facility transfer, a discharge drop home, a body transport. A vehicle is not a bed and not a
 * theatre — a patient is not admitted to it; a TRIP is dispatched on it for a window of time. So the
 * shape mirrors B5 (theatres): a small registry, and a scheduled/occupying booking on top.
 *
 * ── THE COLLISION RULE, HONESTLY STATED ─────────────────────────────────────
 * One ambulance cannot run two trips at once. A trip has a DURATION (start..end), so the rule is an
 * OVERLAP, and an overlap of arbitrary windows is not something a unique index can express. So, like
 * theatres, it is enforced in two layers and the module is candid about which does what:
 *   1. The SERVICE rejects any trip whose window overlaps an existing occupying trip on the same
 *      vehicle (`start < otherEnd && end > otherStart`). This is the real rule.
 *   2. A partial-unique index on `{tenantId, ambulanceId, scheduledStart}` is the RACE backstop for
 *      two identical dispatches submitted at the same instant — the read-then-write window the
 *      overlap check alone would leave. Dispatch is a single-desk operation, so that is the only
 *      concurrency that realistically occurs: overlap in the service, exact-collision in the DB.
 *
 * ── PATIENT IS OPTIONAL, DELIBERATELY ───────────────────────────────────────
 * An emergency dispatch to a roadside precedes registration — there is no UHID yet, only a phone
 * number and a place. Forcing a `patientId` would make the ambulance desk keep a paper log for the
 * one trip that matters most, so `patientId` is optional and a free-text `pickup`/`contactPhone`
 * carries the scene. When the patient is later registered, the trip can be linked.
 *
 * `occupies` is the same derived boolean the theatre/appointment modules use: the partial index
 * keys on its PRESENCE, so it is `true` while the trip holds the vehicle and absent once released.
 * Set in one place (`setStatus`), never by hand.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** The kind of vehicle — groups the list and hints at capability; drives nothing in code. */
export const AMBULANCE_KINDS = [
  "basic_life_support",
  "advanced_life_support",
  "patient_transport",
  "mortuary_van",
] as const;
export type AmbulanceKind = (typeof AMBULANCE_KINDS)[number];

/** `active` takes new dispatches; `inactive` is retired but its history is still readable. */
export const AMBULANCE_STATUSES = ["active", "inactive"] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

export interface AmbulanceDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  /** `Ambulance 1`, `Cardiac Van`. */
  name: string;
  /** Short code, unique per tenant — the human key on the board (`AMB1`). */
  code: string;
  /** The vehicle registration plate (`KA-01-AB-1234`). Optional — demo fleets may lack it. */
  registrationNumber?: string;
  kind: AmbulanceKind;
  status: AmbulanceStatus;

  createdAt: Date;
  updatedAt: Date;
}

/* ── Trip lifecycle (mirroring the theatre booking machine) ── */

export const AMBULANCE_TRIP_STATUSES = [
  "dispatched",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type AmbulanceTripStatus = (typeof AMBULANCE_TRIP_STATUSES)[number];

/** Why the vehicle is out. Groups the board; drives nothing in code. */
export const AMBULANCE_TRIP_PURPOSES = [
  "emergency",
  "transfer",
  "discharge",
  "body_transport",
  "standby",
] as const;
export type AmbulanceTripPurpose = (typeof AMBULANCE_TRIP_PURPOSES)[number];

const TRANSITIONS: Record<AmbulanceTripStatus, AmbulanceTripStatus[]> = {
  dispatched: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: AmbulanceTripStatus, to: AmbulanceTripStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which a trip HOLDS its vehicle window. Terminal states release it. */
const OCCUPYING: AmbulanceTripStatus[] = ["dispatched", "in_progress"];

export function occupiesVehicle(status: AmbulanceTripStatus): boolean {
  return OCCUPYING.includes(status);
}

export interface AmbulanceTripStatusChange {
  from: AmbulanceTripStatus;
  to: AmbulanceTripStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface AmbulanceTripDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  ambulanceId: Types.ObjectId;
  /** The patient, when there is one — an emergency dispatch may precede registration (see header). */
  patientId?: string;
  /** The clinical encounter this trip belongs to, when there is one (ADR-0013). */
  encounterId?: Types.ObjectId;
  /** The driver — a staff user id, trusted as opaque like `appointment.doctorId`. Optional. */
  driverId?: string;

  purpose: AmbulanceTripPurpose;
  /** Free-text scene, so an unregistered emergency still records where the vehicle went. */
  pickup?: string;
  dropoff?: string;
  /** The caller/attendant number for a scene with no UHID yet. */
  contactPhone?: string;

  scheduledStart: Date;
  scheduledEnd: Date;

  status: AmbulanceTripStatus;
  /**
   * Derived from `status`. `undefined` (not `false`) when the window is free — the partial index
   * keys on the field's PRESENCE and a stored `false` would still be indexed (theatre.model.ts).
   */
  occupies?: true;

  notes?: string;
  statusHistory: AmbulanceTripStatusChange[];
  dispatchedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const ambulanceSchema = new Schema<AmbulanceDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 24 },
    registrationNumber: { type: String, trim: true, uppercase: true, maxlength: 32 },
    kind: { type: String, enum: AMBULANCE_KINDS, required: true, default: "basic_life_support" },
    status: { type: String, enum: AMBULANCE_STATUSES, required: true, default: "active" },
  },
  // Indexes owned by migration 0032, never autoIndex — see the patient model.
  { timestamps: true, collection: "ambulances", autoIndex: false },
);

const ambulanceTripSchema = new Schema<AmbulanceTripDoc>(
  {
    tenantId: { type: String, required: true, index: true },
    branchId: { type: String },

    ambulanceId: { type: Schema.Types.ObjectId, required: true },
    patientId: { type: String },
    encounterId: { type: Schema.Types.ObjectId },
    driverId: { type: String },

    purpose: { type: String, enum: AMBULANCE_TRIP_PURPOSES, required: true, default: "transfer" },
    pickup: { type: String, trim: true, maxlength: 200 },
    dropoff: { type: String, trim: true, maxlength: 200 },
    contactPhone: { type: String, trim: true, maxlength: 20 },

    scheduledStart: { type: Date, required: true },
    scheduledEnd: { type: Date, required: true },

    status: { type: String, enum: AMBULANCE_TRIP_STATUSES, required: true, default: "dispatched" },
    // `default: undefined` is load-bearing: a materialized `false` would be indexed by the partial
    // index that keys on existence (PROJECT_MEMORY §8, theatre.model.ts).
    occupies: { type: Boolean, default: undefined },

    notes: { type: String, trim: true, maxlength: 1000 },
    statusHistory: {
      type: [
        new Schema<AmbulanceTripStatusChange>(
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
    dispatchedBy: { type: String },
  },
  { timestamps: true, collection: "ambulanceTrips", autoIndex: false },
);

ambulanceSchema.plugin(tenantScopePlugin);
ambulanceTripSchema.plugin(tenantScopePlugin);

// A vehicle is estate configuration — `admin`, like `theatres` and `wards`.
ambulanceSchema.plugin(auditPlugin, { resource: "ambulance", category: "admin" });
// A trip may name a patient and a scene — that is PHI, like a theatre booking. `occupies` is an
// index key, not a fact about the patient; the history is noise.
ambulanceTripSchema.plugin(auditPlugin, {
  resource: "ambulanceTrip",
  category: "phi",
  ignore: ["occupies", "statusHistory"],
});

export function getAmbulanceModel(conn: Connection): Model<AmbulanceDoc> {
  return (
    (conn.models.Ambulance as Model<AmbulanceDoc>) ??
    conn.model<AmbulanceDoc>("Ambulance", ambulanceSchema)
  );
}

export function getAmbulanceTripModel(conn: Connection): Model<AmbulanceTripDoc> {
  return (
    (conn.models.AmbulanceTrip as Model<AmbulanceTripDoc>) ??
    conn.model<AmbulanceTripDoc>("AmbulanceTrip", ambulanceTripSchema)
  );
}
