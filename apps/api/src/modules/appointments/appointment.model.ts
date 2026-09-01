/**
 * Appointments + doctor schedules (tenant DB, Doc 02 E1/D2, Doc 03 §6).
 *
 * ── THE ONE INVARIANT THAT MATTERS ───────────────────────────────────────────
 * A doctor cannot be in two places at once. Everything else here is bookkeeping;
 * that is the property the module exists to guarantee, and it is guaranteed by a
 * UNIQUE INDEX, not by a check in the service.
 *
 * The reason is a race nobody can code around: two receptionists open the same
 * 10:30 slot, both see it free, both book. A service-level "is it taken?" check
 * cannot prevent that — between the read and the write there is a window, and at
 * a busy front desk that window gets hit. Only the database can arbitrate, so the
 * database does: `{tenantId, doctorId, startAt}` is unique among appointments that
 * OCCUPY their slot, the second writer gets a duplicate-key error, and the service
 * turns it into HMS-APT-001 with alternatives (migration 0010).
 *
 * ── WHY `occupies` EXISTS ────────────────────────────────────────────────────
 * A cancelled appointment must free its slot; a booked one must hold it. So the
 * uniqueness applies only to appointments in an occupying state, which is what a
 * PARTIAL index expresses. Mongo's `partialFilterExpression` cannot say
 * `status: {$in: [...]}`, so the occupying states are collapsed into one boolean
 * that the service maintains alongside `status`. It is derived state, and derived
 * state can drift — so it is set in exactly one place (`setStatus`), never by hand.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

/** STATE_MACHINE_CATALOG §1. Terminal: completed, cancelled, no_show, rescheduled. */
export const APPOINTMENT_STATUSES = [
  "requested",
  "confirmed",
  "checked_in",
  "in_consultation",
  "completed",
  "cancelled",
  "no_show",
  "rescheduled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * The legal transitions, verbatim from STATE_MACHINE_CATALOG §1. This is the ONLY
 * place they are written down in code — the catalog says to implement the
 * lifecycle as a single guard rather than scattered `if (status === …)` checks,
 * because scattered checks are how a state machine acquires an illegal edge that
 * nobody notices until a patient is marked `completed` without ever arriving.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "cancelled", "no_show", "rescheduled"],
  checked_in: ["in_consultation", "cancelled"],
  in_consultation: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * States in which the appointment HOLDS its slot. `rescheduled` releases it (the
 * replacement appointment holds the new one), and the three other terminal states
 * obviously release it. `completed` releases too: the consultation is over, and a
 * past slot cannot be double-booked because you cannot book into the past.
 */
const OCCUPYING: AppointmentStatus[] = ["requested", "confirmed", "checked_in", "in_consultation"];

export function occupiesSlot(status: AppointmentStatus): boolean {
  return OCCUPYING.includes(status);
}

export interface StatusChange {
  from: AppointmentStatus;
  to: AppointmentStatus;
  at: Date;
  by?: string;
  reason?: string;
}

export interface AppointmentDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;

  patientId: string;
  doctorId: string;
  departmentId?: string;

  startAt: Date;
  endAt: Date;

  status: AppointmentStatus;
  /**
   * Derived from `status` — see the header. `undefined` (not `false`) when the
   * slot is free, because the partial index keys on the field's presence and a
   * stored `false` would still be indexed.
   */
  occupies?: true;

  reason?: string;
  /**
   * The Encounter this appointment produced at check-in (ADR-0013).
   *
   * An appointment is a PROMISE of a visit; this is the visit it became. The TOKEN
   * lives on the encounter, not here — a walk-in has a token and no appointment, and
   * in a government hospital that is every single patient.
   */
  encounterId?: Types.ObjectId;

  /** Set on the OLD appointment when it is rescheduled — links the chain. */
  rescheduledTo?: Types.ObjectId;

  /** Every transition, with who and why. A clinical record of what happened when. */
  statusHistory: StatusChange[];

  bookedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new Schema<AppointmentDoc>(
  {
    branchId: { type: String, required: true },
    patientId: { type: String, required: true },
    doctorId: { type: String, required: true },
    departmentId: { type: String },

    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },

    status: { type: String, enum: APPOINTMENT_STATUSES, required: true, default: "requested" },
    // `default: undefined` is load-bearing (PROJECT_MEMORY §8): Mongoose would
    // otherwise materialize the path, and a materialized `false` is still indexed
    // by a partial index that keys on existence.
    occupies: { type: Boolean, default: undefined },

    reason: { type: String, trim: true, maxlength: 500 },
    encounterId: { type: Schema.Types.ObjectId },
    rescheduledTo: { type: Schema.Types.ObjectId },

    statusHistory: {
      type: [
        new Schema<StatusChange>(
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
  { timestamps: true, collection: "appointments", autoIndex: false },
);

appointmentSchema.plugin(tenantScopePlugin);

/**
 * PHI: an appointment says this named person is seeing this named doctor about
 * something, on a date. That is health information even before anyone writes a
 * note. `occupies` is ignored — it is an index key, not a fact about the patient,
 * and a "occupies changed" line beside every status change is noise.
 */
appointmentSchema.plugin(auditPlugin, {
  resource: "appointment",
  category: "phi",
  ignore: ["occupies", "statusHistory"],
});

export function getAppointmentModel(conn: Connection): Model<AppointmentDoc> {
  return (
    (conn.models.Appointment as Model<AppointmentDoc>) ??
    conn.model<AppointmentDoc>("Appointment", appointmentSchema)
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Doctor schedules (Doc 02 D2) — when a doctor is available.
 *
 * A weekly recurring template, not a list of concrete slots. Storing every slot
 * for every doctor forever would be millions of rows describing something that
 * fits in one: "Dr Rao, Tuesdays, 09:00–13:00, 15 minutes each". Slots are
 * COMPUTED for the day being viewed (`slots.ts`) and only appointments are stored.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DoctorScheduleDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;
  doctorId: string;
  /** 0 = Sunday … 6 = Saturday, in the hospital's local reckoning. */
  weekday: number;
  /** Minutes from local midnight — 540 = 09:00. Not a Date: this is a time of day, every week. */
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const doctorScheduleSchema = new Schema<DoctorScheduleDoc>(
  {
    branchId: { type: String, required: true },
    doctorId: { type: String, required: true },
    weekday: { type: Number, required: true, min: 0, max: 6 },
    startMinute: { type: Number, required: true, min: 0, max: 1439 },
    endMinute: { type: Number, required: true, min: 1, max: 1440 },
    slotMinutes: { type: Number, required: true, min: 5, max: 240 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: "doctorSchedules", autoIndex: false },
);

doctorScheduleSchema.plugin(tenantScopePlugin);

// `admin`, not `phi`: a doctor's working hours are roster data, not health data.
doctorScheduleSchema.plugin(auditPlugin, { resource: "doctorSchedule", category: "admin" });

export function getDoctorScheduleModel(conn: Connection): Model<DoctorScheduleDoc> {
  return (
    (conn.models.DoctorSchedule as Model<DoctorScheduleDoc>) ??
    conn.model<DoctorScheduleDoc>("DoctorSchedule", doctorScheduleSchema)
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Doctor leave (Doc 02 D2) — when a doctor is AWAY, overriding the weekly schedule.
 *
 * A weekly template says a doctor works Tuesdays; leave says "not this Tuesday — she
 * is at a conference". So leave is the exception that wins: a day covered by leave
 * offers no slots and takes no bookings, even though the schedule would.
 *
 * Dates are stored as `YYYY-MM-DD` STRINGS, not Date instants, and that is deliberate.
 * Leave is a whole-day concept in the hospital's local reckoning — the same reckoning
 * `slots.ts` uses (minutes from local midnight, no DST in the launch markets). A string
 * date has no timezone to shift under it, so "off on the 14th" cannot become the 13th
 * for a viewer in another zone. Inclusive range: `fromDate <= day <= toDate`, and a
 * single day is `fromDate === toDate`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DoctorLeaveDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;
  doctorId: string;
  /** First day off, inclusive — `YYYY-MM-DD` in the hospital's local reckoning. */
  fromDate: string;
  /** Last day off, inclusive — equals `fromDate` for a single day. */
  toDate: string;
  /** Why — leave / conference / sick. Shown on the roster; optional. */
  reason?: string;
  /** The user who recorded it, for the audit trail. */
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const doctorLeaveSchema = new Schema<DoctorLeaveDoc>(
  {
    branchId: { type: String },
    doctorId: { type: String, required: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reason: { type: String, trim: true, maxlength: 200 },
    createdBy: { type: String },
  },
  { timestamps: true, collection: "doctorLeave", autoIndex: false },
);

doctorLeaveSchema.plugin(tenantScopePlugin);

// `admin`, not `phi`: a doctor being on leave is roster data, not health data.
doctorLeaveSchema.plugin(auditPlugin, { resource: "doctorLeave", category: "admin" });

export function getDoctorLeaveModel(conn: Connection): Model<DoctorLeaveDoc> {
  return (
    (conn.models.DoctorLeave as Model<DoctorLeaveDoc>) ??
    conn.model<DoctorLeaveDoc>("DoctorLeave", doctorLeaveSchema)
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Doctor availability (Doc 02 D2) — the SIMPLE weekly roster reception reads.
 *
 * Indian OPD reality: a doctor is "in" for the MORNING or the AFTERNOON, not for a
 * grid of 15-minute clock slots. So availability is named SESSIONS per weekday, and
 * reception books a patient into a session, not a minute. This is a deliberately
 * separate, simpler concept from the slot-based `doctorSchedules` (which stays for
 * hospitals that do run timed appointment books) — one row per doctor per weekday,
 * carrying the set of sessions the doctor holds that day.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The named parts of a clinic day. `full_day` is its own option, not morning+afternoon. */
export const DOCTOR_SESSIONS = ["morning", "afternoon", "evening", "full_day"] as const;
export type DoctorSession = (typeof DOCTOR_SESSIONS)[number];

export interface DoctorAvailabilityDoc {
  _id: Types.ObjectId;
  tenantId: string;
  branchId?: string;
  doctorId: string;
  /** 0 = Sunday … 6 = Saturday, in the hospital's local reckoning. */
  weekday: number;
  /** The sessions the doctor is present that weekday. Never stored empty — an empty set clears the day. */
  sessions: DoctorSession[];
  createdAt: Date;
  updatedAt: Date;
}

const doctorAvailabilitySchema = new Schema<DoctorAvailabilityDoc>(
  {
    branchId: { type: String, required: true },
    doctorId: { type: String, required: true },
    weekday: { type: Number, required: true, min: 0, max: 6 },
    sessions: { type: [String], required: true, enum: DOCTOR_SESSIONS },
  },
  { timestamps: true, collection: "doctorAvailability", autoIndex: false },
);

doctorAvailabilitySchema.plugin(tenantScopePlugin);

// `admin`, not `phi`: a doctor's working sessions are roster data, not health data.
doctorAvailabilitySchema.plugin(auditPlugin, { resource: "doctorAvailability", category: "admin" });

export function getDoctorAvailabilityModel(conn: Connection): Model<DoctorAvailabilityDoc> {
  return (
    (conn.models.DoctorAvailability as Model<DoctorAvailabilityDoc>) ??
    conn.model<DoctorAvailabilityDoc>("DoctorAvailability", doctorAvailabilitySchema)
  );
}
