/**
 * Appointment repository — the ONLY code that queries `appointments` and
 * `doctorSchedules` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { getTenantDb } from "../../core/context/requestContext.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getAppointmentModel,
  getDoctorScheduleModel,
  occupiesSlot,
  type AppointmentDoc,
  type AppointmentStatus,
  type DoctorScheduleDoc,
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
  tokenNumber?: number;
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
    ...(doc.tokenNumber !== undefined ? { tokenNumber: doc.tokenNumber } : {}),
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

export async function findById(
  id: string,
  session?: ClientSession,
): Promise<Appointment | undefined> {
  const doc = await getAppointmentModel(getTenantDb())
    .findById(id)
    .session(session ?? null);
  return doc ? toAppointment(doc) : undefined;
}

export async function findByIdScoped(id: string): Promise<Appointment | undefined> {
  const doc = await getAppointmentModel(getTenantDb()).findOne({ _id: id, ...scopeFilter() });
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

/** The next token number for a doctor's day — assigned at CHECK-IN, in arrival order. */
export async function nextTokenNumber(
  doctorId: string,
  dayStart: Date,
  dayEnd: Date,
  session: ClientSession,
): Promise<number> {
  const highest = await getAppointmentModel(getTenantDb())
    .findOne({ doctorId, startAt: { $gte: dayStart, $lt: dayEnd }, tokenNumber: { $exists: true } })
    .sort({ tokenNumber: -1 })
    .select("tokenNumber")
    .session(session);

  return (highest?.tokenNumber ?? 0) + 1;
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

export async function findSchedules(doctorId: string, weekday?: number): Promise<DoctorSchedule[]> {
  const query: Record<string, unknown> = { doctorId, active: true };
  if (weekday !== undefined) query.weekday = weekday;

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
    { doctorId: input.doctorId, weekday: input.weekday },
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
