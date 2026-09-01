/**
 * Appointment repository — the ONLY code that queries `appointments`,
 * `doctorSchedules` and `doctorLeave` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getAppointmentModel,
  getDoctorScheduleModel,
  getDoctorLeaveModel,
  getDoctorAvailabilityModel,
  occupiesSlot,
  type AppointmentDoc,
  type AppointmentStatus,
  type DoctorScheduleDoc,
  type DoctorLeaveDoc,
  type DoctorAvailabilityDoc,
  type DoctorSession,
  type StatusChange,
} from "./appointment.model.js";

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  branchId?: string;
  departmentId?: string;
  startAt: Date;
  endAt: Date;
  status: AppointmentStatus;
  reason?: string;
  encounterId?: string;
  rescheduledTo?: string;
  statusHistory: StatusChange[];
  createdAt: Date;
}

function toAppointment(doc: AppointmentDoc): Appointment {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId,
    doctorId: doc.doctorId,
    startAt: doc.startAt,
    endAt: doc.endAt,
    status: doc.status,
    statusHistory: doc.statusHistory ?? [],
    createdAt: doc.createdAt,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    ...(doc.departmentId ? { departmentId: doc.departmentId } : {}),
    ...(doc.reason ? { reason: doc.reason } : {}),
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    ...(doc.rescheduledTo ? { rescheduledTo: doc.rescheduledTo.toString() } : {}),
  };
}

/**
 * Mongo's duplicate-key error. The ONE signal that a slot was taken between our
 * read and our write. Shared with the notification ledger, which uses the same
 * mechanism to enforce one-message-per-cause (core/db/mongoErrors.ts).
 */
export { isDuplicateKey } from "../../core/db/mongoErrors.js";

export interface CreateAppointmentInput {
  patientId: string;
  doctorId: string;
  branchId?: string;
  departmentId?: string;
  startAt: Date;
  endAt: Date;
  reason?: string;
  bookedBy?: string;
}

/**
 * Inserts an appointment. THROWS a duplicate-key error if the doctor is already
 * booked at that instant — that rejection is the point, and the caller must
 * translate it (see the service). Do not add a "check first" here: the check is
 * the index.
 */
export async function create(
  input: CreateAppointmentInput,
  session: ClientSession,
): Promise<Appointment> {
  const [doc] = await getAppointmentModel(getTenantDb()).create(
    [
      {
        ...input,
        status: "requested",
        occupies: true,
        statusHistory: [{ from: "requested", to: "requested", at: new Date(), by: input.bookedBy }],
      },
    ],
    { session },
  );

  if (!doc) throw new Error("appointment insert returned no document");
  return toAppointment(doc);
}

/**
 * One appointment by id, at the sites the caller may actually work in.
 *
 * ── WHY THERE IS NO LONGER AN UNSCOPED TWIN ─────────────────────────────────
 * This module used to ship two reads: `findById` (bare) and `findByIdScoped`. The read paths
 * picked the scoped one and the STATE MACHINE picked the bare one, so every transition it
 * drives — confirm, check-in, start, complete, no-show, cancel — resolved an appointment
 * belonging to any site in the hospital. `appointment:update` and `appointment:cancel` are
 * both declared `"branch"`, so that contradicted the permission catalogue, and it did it on a
 * WRITE: a clerk at one site could cancel another site's clinic list, or mark a patient
 * sitting in a waiting room 600km away as a no-show, with the audit trail recording it as a
 * legitimate action. Proven by the branch-isolation suite, which failed on exactly this.
 *
 * Two functions where one is safe and one is not is a choice nobody should have to make
 * correctly every time, so there is now one. `scopeFilter()` returns `{}` when there is no
 * `ctx.scope` — seeds, migrations, queue consumers — so internal callers are unaffected,
 * exactly as `writeBranchId` treats an absent scope.
 */
export async function findById(
  id: string,
  session?: ClientSession,
): Promise<Appointment | undefined> {
  const doc = await getAppointmentModel(getTenantDb())
    .findOne({ _id: id, ...scopeFilter() })
    .session(session ?? null);
  return doc ? toAppointment(doc) : undefined;
}

/**
 * Moves an appointment to a new status and maintains `occupies` in the SAME write.
 *
 * `occupies` is derived from `status`, so the two must never be set apart — a
 * cancelled appointment still holding `occupies: true` silently blocks its slot
 * forever, and nobody would know why 10:30 can never be booked again.
 */
export async function setStatus(
  id: string,
  to: AppointmentStatus,
  change: StatusChange,
  session: ClientSession,
  extra: Record<string, unknown> = {},
): Promise<Appointment | undefined> {
  const update: Record<string, unknown> = {
    $set: { status: to, ...extra },
    $push: { statusHistory: change },
  };

  if (occupiesSlot(to)) {
    (update.$set as Record<string, unknown>).occupies = true;
  } else {
    update.$unset = { occupies: "" };
  }

  const doc = await getAppointmentModel(getTenantDb()).findOneAndUpdate({ _id: id }, update, {
    new: true,
    session,
  });
  return doc ? toAppointment(doc) : undefined;
}

/** The instants a doctor is already booked on a given day — what `availableSlots` subtracts. */
export async function bookedStartsFor(doctorId: string, from: Date, to: Date): Promise<Date[]> {
  const docs = await getAppointmentModel(getTenantDb())
    .find({ doctorId, occupies: true, startAt: { $gte: from, $lt: to } })
    .select("startAt");

  return docs.map((d) => d.startAt);
}

/**
 * Which of these patients already have a future appointment that HOLDS a slot.
 *
 * ── `occupies` IS THE WHOLE ANSWER TO "DOES A CANCELLATION COUNT?" ──────────
 * It does not, and no code here says so. `occupies` is the same derived flag the unique index
 * uses to decide whether an appointment holds a doctor's time, and a cancelled, no-showed or
 * rescheduled one releases it. So a patient whose follow-up booking was cancelled reappears on
 * the chase list automatically — which is exactly right, and is a property inherited rather than
 * re-implemented. Reusing the flag means "is this appointment still happening?" keeps having one
 * answer in this codebase.
 *
 * Branch-scoped like the list it feeds: an appointment at the other site does not discharge this
 * site's follow-up.
 */
export async function upcomingForPatients(
  patientIds: readonly string[],
  from: Date,
): Promise<{ patientId: string; startAt: Date }[]> {
  if (patientIds.length === 0) return [];

  const docs = await getAppointmentModel(getTenantDb())
    .find({
      patientId: { $in: [...patientIds] },
      occupies: true,
      startAt: { $gte: from },
      ...scopeFilter(),
    })
    .select("patientId startAt")
    .lean<Pick<AppointmentDoc, "_id" | "patientId" | "startAt">[]>();

  return docs.map((d) => ({ patientId: d.patientId, startAt: d.startAt }));
}

export interface ListAppointmentsFilter {
  page: number;
  limit: number;
  doctorId?: string;
  patientId?: string;
  status?: AppointmentStatus;
  from?: Date;
  to?: Date;
}

export async function list(
  filter: ListAppointmentsFilter,
): Promise<{ appointments: Appointment[]; total: number }> {
  const model = getAppointmentModel(getTenantDb());

  const query: Record<string, unknown> = { ...scopeFilter() };
  if (filter.doctorId) query.doctorId = filter.doctorId;
  if (filter.patientId) query.patientId = filter.patientId;
  if (filter.status) query.status = filter.status;
  if (filter.from || filter.to) {
    query.startAt = {
      ...(filter.from ? { $gte: filter.from } : {}),
      ...(filter.to ? { $lt: filter.to } : {}),
    };
  }

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ startAt: 1 })
      .skip((filter.page - 1) * filter.limit)
      .limit(filter.limit),
    model.countDocuments(query),
  ]);

  return { appointments: docs.map(toAppointment), total };
}

/* ── doctor schedules ─────────────────────────────────────────────────────── */

export interface DoctorSchedule {
  id: string;
  doctorId: string;
  branchId?: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  active: boolean;
}

function toSchedule(doc: DoctorScheduleDoc): DoctorSchedule {
  return {
    id: doc._id.toString(),
    doctorId: doc.doctorId,
    weekday: doc.weekday,
    startMinute: doc.startMinute,
    endMinute: doc.endMinute,
    slotMinutes: doc.slotMinutes,
    active: doc.active,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

/**
 * The key a weekday template is upserted on — `{doctor, weekday}` AT A SITE (ADR-0015).
 *
 * `$exists: false` rather than `null` for the branchless case, and the difference matters at the
 * upsert: Mongo copies equality fields from the filter into an inserted document, so `null` would
 * WRITE `branchId: null` and quietly break every `{$exists: false}` audit and backfill that looks
 * for unstamped rows. `$exists` is not an equality, so the insert simply omits the field — which
 * is the state a single-site hospital is supposed to be in until its Main Branch is seeded.
 */
function branchKey(branchId?: string): Record<string, unknown> {
  return branchId ? { branchId } : { branchId: { $exists: false } };
}

/**
 * A doctor's active weekly templates. `branchId` narrows to ONE SITE's clinic — pass the branch
 * the slots are being computed for, so "Monday" means Monday *here* and a Chennai session never
 * offers slots to a Hyderabad booking. Omitted, it returns the doctor's templates everywhere,
 * which is what a single-site hospital (and the roster screen) wants.
 */
export async function findSchedules(
  doctorId: string,
  weekday?: number,
  branchId?: string,
): Promise<DoctorSchedule[]> {
  const query: Record<string, unknown> = { doctorId, active: true };
  if (weekday !== undefined) query.weekday = weekday;
  if (branchId) query.branchId = branchId;

  const docs = await getDoctorScheduleModel(getTenantDb()).find(query);
  return docs.map(toSchedule);
}

export async function upsertSchedule(input: {
  doctorId: string;
  branchId?: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}): Promise<DoctorSchedule> {
  const doc = await getDoctorScheduleModel(getTenantDb()).findOneAndUpdate(
    { doctorId: input.doctorId, weekday: input.weekday, ...branchKey(input.branchId) },
    { ...input, active: true },
    { new: true, upsert: true },
  );
  return toSchedule(doc);
}

export async function deactivateSchedule(id: string): Promise<boolean> {
  const doc = await getDoctorScheduleModel(getTenantDb()).findOneAndUpdate(
    { _id: id },
    { active: false },
    { new: true },
  );
  return Boolean(doc);
}

/* ── doctor leave ─────────────────────────────────────────────────────────── */

export interface DoctorLeave {
  id: string;
  doctorId: string;
  branchId?: string;
  fromDate: string;
  toDate: string;
  reason?: string;
}

function toLeave(doc: DoctorLeaveDoc): DoctorLeave {
  return {
    id: doc._id.toString(),
    doctorId: doc.doctorId,
    fromDate: doc.fromDate,
    toDate: doc.toDate,
    ...(doc.reason ? { reason: doc.reason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

/** A doctor's leave, most recent first — the roster view. Branch-scoped like every read. */
export async function findLeave(doctorId: string): Promise<DoctorLeave[]> {
  const docs = await getDoctorLeaveModel(getTenantDb())
    .find({ doctorId, ...scopeFilter() })
    .sort({ fromDate: -1 })
    .lean<DoctorLeaveDoc[]>();
  return docs.map(toLeave);
}

/**
 * Is the doctor on leave on `dateStr` (`YYYY-MM-DD`)? True when any leave range covers
 * it inclusively. This is the one query availability and booking consult — a string
 * comparison, because `YYYY-MM-DD` sorts chronologically as text.
 */
export async function isOnLeave(doctorId: string, dateStr: string): Promise<boolean> {
  const hit = await getDoctorLeaveModel(getTenantDb())
    .findOne({
      doctorId,
      fromDate: { $lte: dateStr },
      toDate: { $gte: dateStr },
      ...scopeFilter(),
    })
    .lean<DoctorLeaveDoc>();
  return Boolean(hit);
}

export async function addLeave(input: {
  doctorId: string;
  branchId?: string;
  fromDate: string;
  toDate: string;
  reason?: string;
}): Promise<DoctorLeave> {
  const ctx = getContext();
  const doc = await getDoctorLeaveModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    doctorId: input.doctorId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(ctx.userId ? { createdBy: ctx.userId } : {}),
  });
  return toLeave(doc.toObject() as DoctorLeaveDoc);
}

/**
 * Deleted, not soft-deleted: unlike a schedule, no appointment is booked "against" a
 * leave row — it only ever suppressed slots — so removing it leaves nothing dangling.
 */
export async function removeLeave(id: string): Promise<boolean> {
  const doc = await getDoctorLeaveModel(getTenantDb())
    .findOneAndDelete({ _id: id, ...scopeFilter() })
    .lean<DoctorLeaveDoc>();
  return Boolean(doc);
}

/**
 * The same delete, restricted to ONE doctor's rows — what `/doctors/me/leave/:id` uses.
 *
 * ── ONE QUERY, NOT A READ THEN A CHECK THEN A DELETE ────────────────────────
 * `doctorId` is part of the FILTER rather than something verified beforehand, so there is no
 * window between the check and the delete for the row to change under it, and no code path where
 * a future edit forgets the check. A row belonging to somebody else simply does not match.
 *
 * The caller turns "no match" into a 404 rather than a 403, deliberately: distinguishing "that
 * leave row is not yours" from "no such row" would confirm to any doctor that a colleague has
 * leave booked with that id, which is roster information they were not granted.
 */
export async function removeOwnLeave(id: string, doctorId: string): Promise<boolean> {
  const doc = await getDoctorLeaveModel(getTenantDb())
    .findOneAndDelete({ _id: id, doctorId, ...scopeFilter() })
    .lean<DoctorLeaveDoc>();
  return Boolean(doc);
}

/* ── doctor availability (session roster) ─────────────────────────────────── */

export interface DoctorAvailability {
  doctorId: string;
  weekday: number;
  sessions: DoctorSession[];
  branchId?: string;
}

function toAvailability(doc: DoctorAvailabilityDoc): DoctorAvailability {
  return {
    doctorId: doc.doctorId,
    weekday: doc.weekday,
    sessions: doc.sessions,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

/** A doctor's whole week, ordered Sunday→Saturday — what the roster and reception read. */
export async function findAvailability(doctorId: string): Promise<DoctorAvailability[]> {
  const docs = await getDoctorAvailabilityModel(getTenantDb())
    .find({ doctorId, ...scopeFilter() })
    .sort({ weekday: 1 })
    .lean<DoctorAvailabilityDoc[]>();
  return docs.map(toAvailability);
}

/**
 * Sets the sessions a doctor holds on one weekday. An empty set DELETES the day's row —
 * "not in" is the absence of a row, not a row that says nothing, so the roster stays clean.
 */
export async function setAvailability(input: {
  doctorId: string;
  branchId?: string;
  weekday: number;
  sessions: DoctorSession[];
}): Promise<DoctorAvailability | undefined> {
  const ctx = getContext();
  const model = getDoctorAvailabilityModel(getTenantDb());

  if (input.sessions.length === 0) {
    // Clearing a day clears it AT ONE SITE — the roster row is per branch, like the template.
    await model.deleteOne({
      doctorId: input.doctorId,
      weekday: input.weekday,
      ...branchKey(input.branchId),
      ...scopeFilter(),
    });
    return undefined;
  }

  const doc = await model.findOneAndUpdate(
    { doctorId: input.doctorId, weekday: input.weekday, ...branchKey(input.branchId) },
    {
      $set: {
        sessions: input.sessions,
        ...(input.branchId ? { branchId: input.branchId } : {}),
      },
      $setOnInsert: { tenantId: ctx.tenantId },
    },
    { new: true, upsert: true },
  );
  return toAvailability(doc);
}

/**
 * Move a merged patient's appointments onto the survivor (patient.patients.merged).
 * `patientId` is stored as a STRING here (not an ObjectId), hence objectId: false.
 * Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  return repointPatientId(getAppointmentModel(getTenantDb()), "patientId", ref, {
    objectId: false,
  });
}
