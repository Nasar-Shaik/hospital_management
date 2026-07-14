/**
 * Appointments (Doc 02 E1, BUSINESS_WORKFLOWS §2, STATE_MACHINE_CATALOG §1).
 *
 * ── BOOKING IS A RACE, AND WE LET THE DATABASE WIN IT ────────────────────────
 * Two receptionists open the same 10:30 slot, both see it free, both click book.
 * No amount of checking prevents this — between the read and the write there is a
 * window, and at a busy front desk that window gets hit. So the service does NOT
 * check whether the slot is free. It writes, and a unique index arbitrates: the
 * loser gets a duplicate-key error, which becomes `HMS-APT-001` carrying the next
 * few open slots so the clerk can rebook in one motion instead of starting over.
 *
 * This is the same shape as the UHID counter in `patients`: when correctness needs
 * an atomic decision, make the DATABASE make it. A check in application code is a
 * suggestion.
 *
 * ── STATUS CHANGES GO THROUGH ONE DOOR ───────────────────────────────────────
 * `transition()` is the only way an appointment changes state, and it consults
 * `canTransition` (which is the catalog, transcribed once). Scattered
 * `if (status === "confirmed")` checks are how a state machine quietly acquires an
 * illegal edge — a patient marked `completed` who never arrived, a `cancelled`
 * appointment that still holds its slot.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { withTransaction } from "../../core/db/transaction.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { getPatient } from "../patients/index.js";
import * as repo from "./appointment.repository.js";
import { canTransition, type AppointmentStatus } from "./appointment.model.js";
import { availableSlots, slotsFor, type Slot } from "./slots.js";

export type { Appointment, DoctorSchedule } from "./appointment.repository.js";

/** HMS-APT-001 — the slot went while the clerk was typing. Carries a way forward. */
class SlotUnavailableError extends AppError {
  constructor(details: unknown) {
    super("HMS-APT-001", 409, "Slot no longer available", details);
  }
}

/** HMS-STATE-001 — an edge that does not exist in STATE_MACHINE_CATALOG §1. */
function invalidTransition(from: AppointmentStatus, to: AppointmentStatus): AppError {
  return new AppError("HMS-STATE-001", 422, "Invalid state transition", { from, to });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 1);
  return x;
}

/**
 * The slots a doctor still has open on a day.
 *
 * Read-only and cheap, and it is what the booking screen calls. It is explicitly
 * NOT a reservation: a slot returned here can be taken a second later by someone
 * else, which is exactly why booking does not trust it.
 */
export async function getAvailability(
  doctorId: string,
  day: Date,
  now = new Date(),
): Promise<Slot[]> {
  const schedules = await repo.findSchedules(doctorId, day.getDay());
  if (schedules.length === 0) return [];

  const taken = await repo.bookedStartsFor(doctorId, startOfDay(day), endOfDay(day));

  // A doctor may hold more than one session in a day (a morning and an evening
  // clinic), so the slots of every matching template are unioned.
  const all = schedules.flatMap((s) => slotsFor(day, s));
  return availableSlots(all, taken, now).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

export interface BookAppointmentInput {
  patientId: string;
  doctorId: string;
  startAt: Date;
  branchId?: string;
  departmentId?: string;
  reason?: string;
}

export async function bookAppointment(input: BookAppointmentInput): Promise<repo.Appointment> {
  const ctx = getContext();

  // The patient must exist and be visible to THIS caller — `getPatient` applies the
  // row scope, so a branch-confined clerk cannot book an appointment for a patient
  // they are not allowed to see, and cannot discover one by probing ids either.
  const patient = await getPatient(input.patientId);
  if (patient.status === "merged") {
    // Booking onto a chart a human has already retired is how the merge gets undone
    // in practice: the appointment, and everything hung off it, lands on the dead record.
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      patientId: patient.id,
      reason: "this patient record was merged; book against the surviving record",
      ...(patient.mergedInto ? { mergedInto: patient.mergedInto } : {}),
    });
  }

  /**
   * The slot must belong to the doctor's schedule. Without this, any instant is
   * bookable and the schedule becomes decorative — you get 03:47 appointments and
   * a doctor with no idea they were expected.
   */
  const schedules = await repo.findSchedules(input.doctorId, input.startAt.getDay());
  const offered = schedules.flatMap((s) => slotsFor(input.startAt, s));
  const slot = offered.find((s) => s.startAt.getTime() === input.startAt.getTime());

  if (!slot) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      startAt: ["the doctor has no clinic session at that time"],
    });
  }

  if (slot.startAt <= new Date()) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      startAt: ["cannot book a slot in the past"],
    });
  }

  try {
    return await withTransaction(async (session) => {
      // No availability check. The unique index decides — see the header.
      const appointment = await repo.create(
        {
          patientId: input.patientId,
          doctorId: input.doctorId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          ...(input.branchId ? { branchId: input.branchId } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(ctx.userId ? { bookedBy: ctx.userId } : {}),
        },
        session,
      );

      // Same transaction as the insert: the appointment and the intent to confirm
      // it commit together, so no reminder is ever sent for a booking that failed.
      await publish(
        {
          name: EVENTS.APPOINTMENT_BOOKED,
          payload: {
            appointmentId: appointment.id,
            patientId: appointment.patientId,
            uhid: patient.uhid,
            doctorId: appointment.doctorId,
            startAt: appointment.startAt.toISOString(),
          },
          ...(input.branchId ? { branchId: input.branchId } : {}),
        },
        session,
      );

      return appointment;
    });
  } catch (err) {
    if (!repo.isDuplicateKey(err)) throw err;

    /**
     * Someone booked this slot between the availability screen and this write.
     * Hand back the next few open slots: a 409 that just says "no" makes the clerk
     * start the whole flow again with a patient standing in front of them.
     */
    const alternatives = (await getAvailability(input.doctorId, input.startAt)).slice(0, 5);
    throw new SlotUnavailableError({
      doctorId: input.doctorId,
      startAt: input.startAt.toISOString(),
      alternatives: alternatives.map((s) => s.startAt.toISOString()),
    });
  }
}

/**
 * The single door every status change goes through (STATE_MACHINE_CATALOG §1).
 * Illegal edges are refused here, once, rather than being prevented by whoever
 * remembers to check.
 */
async function transition(
  id: string,
  to: AppointmentStatus,
  reason?: string,
  /** Extra fields to set in the SAME write as the status — e.g. the reschedule link. */
  alsoSet: Record<string, unknown> = {},
): Promise<repo.Appointment> {
  const ctx = getContext();

  return withTransaction(async (session) => {
    const current = await repo.findById(id, session);
    if (!current) throw new AppError("HMS-GEN-404", 404, "Appointment not found", { id });

    if (!canTransition(current.status, to)) throw invalidTransition(current.status, to);

    const extra: Record<string, unknown> = { ...alsoSet };

    /**
     * Check-in is only legal on the day (catalog guard). Checking a patient in for
     * next Tuesday puts them in today's queue and, worse, makes the doctor's list
     * lie about who is actually waiting.
     */
    if (to === "checked_in") {
      const today = startOfDay(new Date());
      if (current.startAt < today || current.startAt >= endOfDay(new Date())) {
        throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
          from: current.status,
          to,
          reason: "a patient can only be checked in on the day of their appointment",
        });
      }

      // The token is assigned in ARRIVAL order, at check-in — not at booking. Who
      // is seen next is decided by who is here, not by who booked first.
      extra.tokenNumber = await repo.nextTokenNumber(
        current.doctorId,
        today,
        endOfDay(new Date()),
        session,
      );
    }

    const updated = await repo.setStatus(
      id,
      to,
      {
        from: current.status,
        to,
        at: new Date(),
        ...(ctx.userId ? { by: ctx.userId } : {}),
        ...(reason ? { reason } : {}),
      },
      session,
      extra,
    );
    if (!updated) throw new AppError("HMS-GEN-404", 404, "Appointment not found", { id });

    if (to === "cancelled") {
      await publish(
        {
          name: EVENTS.APPOINTMENT_CANCELLED,
          payload: {
            appointmentId: updated.id,
            patientId: updated.patientId,
            doctorId: updated.doctorId,
            startAt: updated.startAt.toISOString(),
            reason: reason ?? null,
            cancelledBy: ctx.userId ?? null,
          },
        },
        session,
      );
    }

    return updated;
  });
}

export const confirmAppointment = (id: string): Promise<repo.Appointment> =>
  transition(id, "confirmed");

/** Cancellation REQUIRES a reason — "cancelled" with no why is useless to everyone downstream. */
export const cancelAppointment = (id: string, reason: string): Promise<repo.Appointment> =>
  transition(id, "cancelled", reason);

export const checkInAppointment = (id: string): Promise<repo.Appointment> =>
  transition(id, "checked_in");

export const startConsultation = (id: string): Promise<repo.Appointment> =>
  transition(id, "in_consultation");

export const completeAppointment = (id: string): Promise<repo.Appointment> =>
  transition(id, "completed");

export const markNoShow = (id: string, reason?: string): Promise<repo.Appointment> =>
  transition(id, "no_show", reason);

/**
 * Rescheduling creates a NEW appointment and links the old one to it — it does not
 * mutate the original's time (catalog §1: "creates new appointment, links parent").
 *
 * The reason is evidential: "this patient was booked for Tuesday and moved to
 * Friday" is a fact somebody will need — for a complaint, for a no-show dispute,
 * for a clinical timeline. Overwriting `startAt` destroys it and leaves a record
 * that claims Friday was always the plan.
 */
export async function rescheduleAppointment(
  id: string,
  startAt: Date,
  reason: string,
): Promise<{ cancelled: repo.Appointment; booked: repo.Appointment }> {
  const current = await repo.findByIdScoped(id);
  if (!current) throw new AppError("HMS-GEN-404", 404, "Appointment not found", { id });

  if (!canTransition(current.status, "rescheduled")) {
    throw invalidTransition(current.status, "rescheduled");
  }

  /**
   * The NEW appointment is booked FIRST, deliberately. If the new slot turns out to
   * be taken, the patient must still hold their original one — releasing it first
   * and then failing would leave them with no appointment at all, which is strictly
   * worse than the reschedule not happening.
   */
  const booked = await bookAppointment({
    patientId: current.patientId,
    doctorId: current.doctorId,
    startAt,
    ...(current.branchId ? { branchId: current.branchId } : {}),
    ...(current.departmentId ? { departmentId: current.departmentId } : {}),
    ...(current.reason ? { reason: current.reason } : {}),
  });

  // The link is written in the SAME transition that retires the old appointment —
  // not in a second write afterwards, which could crash in between and leave a
  // `rescheduled` appointment pointing at nothing.
  const cancelled = await transition(id, "rescheduled", reason, { rescheduledTo: booked.id });

  return { cancelled, booked };
}

export async function getAppointment(id: string): Promise<repo.Appointment> {
  const appointment = await repo.findByIdScoped(id);
  if (!appointment) throw new AppError("HMS-GEN-404", 404, "Appointment not found", { id });
  return appointment;
}

export const listAppointments = (
  filter: repo.ListAppointmentsFilter,
): Promise<{ appointments: repo.Appointment[]; total: number }> => repo.list(filter);

/* ── doctor schedules (Doc 02 D2) ─────────────────────────────────────────── */

export async function setDoctorSchedule(input: {
  doctorId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  branchId?: string;
}): Promise<repo.DoctorSchedule> {
  if (input.endMinute <= input.startMinute) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      endMinute: ["a clinic session must end after it starts"],
    });
  }
  if (input.endMinute - input.startMinute < input.slotMinutes) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      slotMinutes: ["the session is shorter than one slot"],
    });
  }
  return repo.upsertSchedule(input);
}

export const getDoctorSchedules = (doctorId: string): Promise<repo.DoctorSchedule[]> =>
  repo.findSchedules(doctorId);

export async function removeDoctorSchedule(id: string): Promise<void> {
  // Deactivated, never deleted: existing appointments were booked against it, and
  // "why was this patient given a 4pm slot" must remain answerable.
  const removed = await repo.deactivateSchedule(id);
  if (!removed) throw new AppError("HMS-GEN-404", 404, "Schedule not found", { id });
}
