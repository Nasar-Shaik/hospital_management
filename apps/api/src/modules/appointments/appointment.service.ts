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
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { env } from "../../config/env.js";
import { dayKeyInZone, dayRangeInZone } from "../../core/time/day.js";
import { zoneOrDefault } from "../../core/time/zone.js";
import { getPatient } from "../patients/index.js";
import { getBranch } from "../branches/index.js";
import { startEncounter } from "../encounters/index.js";
import * as repo from "./appointment.repository.js";
import { canTransition, type AppointmentStatus } from "./appointment.model.js";
import { availableSlots, slotsFor, type Slot } from "./slots.js";

export type {
  Appointment,
  DoctorSchedule,
  DoctorLeave,
  DoctorAvailability,
} from "./appointment.repository.js";

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

/* ════════════════════════════════════════════════════════════════════════════
 * THE CLINIC'S CLOCK (M0 §21 item C)
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 * Every boundary here used to read the PROCESS timezone: `d.setHours(0,0,0,0)` for the day,
 * `d.getDay()` for the weekday, `d.getFullYear()` for the leave key. That is correct only when the
 * server happens to run in the hospital's zone — and nothing sets `TZ` in the Dockerfile, the
 * compose file or `.env.example`, so the shipped image runs in **UTC**. A clinic configured
 * 09:00–13:00 therefore had its slots generated at 09:00 UTC, which is **14:30 IST**: every
 * appointment in production offered at the wrong time.
 *
 * It survived because the API suite pins `TZ: "Asia/Kolkata"` (vitest.config.ts) — the tests ran in
 * the one timezone where the bug is invisible. `appointments.tz.int.test.ts` is written to be
 * immune to that pin: it puts the clinic in a branch zone 9.5 hours away from the process zone.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A clinic session is a WALL-CLOCK fact at a SITE: "Mondays, 09:00–13:00, in Hyderabad". Every
 * boundary resolves through the branch's own zone, never the container's.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The zone a doctor's clinic keeps: the branch's, else the platform default.
 *
 * A branch row whose timezone was written before `isValidTimeZone` existed falls through
 * `zoneOrDefault` rather than throwing — a booking screen must not 500 over a settings field
 * somebody typed two years ago.
 */
async function clinicZone(branchId?: string): Promise<string> {
  if (!branchId) return env.DEFAULT_TIMEZONE;
  const branch = await getBranch(branchId).catch(() => undefined);
  return zoneOrDefault(branch?.timezone, env.DEFAULT_TIMEZONE);
}

/**
 * `YYYY-MM-DD` at the clinic, for an INSTANT.
 *
 * ── EVERY DATE THAT REACHES THIS SERVICE IS AN INSTANT, AND THAT IS THE CONTRACT ─
 * `?date=` is `z.coerce.date()` and the shipped client sends `date.toISOString()`, so what arrives
 * is a moment, not a calendar square. Which clinic day it belongs to is therefore a genuine zone
 * question and this is the only correct way to ask it.
 *
 * The trap, recorded because the first draft of this fix fell into it: if the parameter ever
 * becomes a date-only `YYYY-MM-DD` string, it must NOT come through here. `2026-08-17` coerces to
 * UTC midnight, which in New York is 20:00 on the 16th — a Monday clinic would resolve to Sunday
 * and the grid would come back empty. A named date has no zone to convert FROM; its parts are the
 * answer. Changing the schema means changing this line with it.
 */
const clinicDayKey = (at: Date, zone: string): string => dayKeyInZone(at, zone);

/** The weekday a `YYYY-MM-DD` key falls on, 0 = Sunday. Parsed as UTC so no zone can shift it. */
function weekdayOf(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
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
  /**
   * Slots are offered for the site the user is WORKING AT. A doctor who runs Monday mornings in
   * Hyderabad and Monday afternoons in Chennai has two templates; showing both to a Hyderabad
   * booker would offer an afternoon the patient cannot attend.
   *
   * The ACTIVE branch, not `writeBranchId()`: this is a read, and a read must not refuse just
   * because the user has picked no site yet (HMS-BRANCH-001 is a write-time rule). With nothing
   * selected the doctor's whole week is offered, exactly as before branches existed.
   */
  const activeBranchId = getContext().activeBranchId;
  const zone = await clinicZone(activeBranchId);

  /**
   * One key, derived once, so the weekday, the leave lookup and the slot anchor cannot disagree
   * about which day is being discussed — which is exactly how the old code drifted.
   */
  const dayKey = clinicDayKey(day, zone);

  const schedules = await repo.findSchedules(doctorId, weekdayOf(dayKey), activeBranchId);
  if (schedules.length === 0) return [];

  // On leave that day → no slots, whatever the weekly schedule says. Leave is the exception that wins.
  if (await repo.isOnLeave(doctorId, dayKey)) return [];

  // The clinic's own day, as UTC instants. Half-open — see `dayRangeInZone`.
  const { from, before } = dayRangeInZone(dayKey, zone);
  const taken = await repo.bookedStartsFor(doctorId, from, before);

  // A doctor may hold more than one session in a day (a morning and an evening
  // clinic), so the slots of every matching template are unioned.
  const all = schedules.flatMap((s) => slotsFor(from, s));
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

/**
 * Checking a patient in for next Tuesday puts them in TODAY's queue and makes the
 * doctor's list lie about who is actually waiting.
 */
async function assertToday(startAt: Date, branchId?: string): Promise<void> {
  // Compared as DAY KEYS at the clinic. On a UTC server the old instant comparison let a 09:00 IST
  // appointment be checked in from 18:30 the evening before, and refused it at 05:00 on the day.
  const zone = await clinicZone(branchId);
  if (clinicDayKey(startAt, zone) !== clinicDayKey(new Date(), zone)) {
    throw new AppError("HMS-STATE-001", 422, "Invalid state transition", {
      to: "checked_in",
      reason: "a patient can only be checked in on the day of their appointment",
    });
  }
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
   * The branch this appointment is booked AT (ADR-0015) — the site the patient will be seen. The
   * encounter created from it later inherits this branch.
   *
   * Resolved BEFORE the schedule check, because it is an input to it: the slot has to exist in
   * the doctor's clinic AT THIS SITE. Resolving it afterwards would validate a Hyderabad booking
   * against a Chennai session and hand the patient a time nobody is there for.
   */
  const branchId = await writeBranchId(input.branchId);

  /**
   * The slot must belong to the doctor's schedule. Without this, any instant is
   * bookable and the schedule becomes decorative — you get 03:47 appointments and
   * a doctor with no idea they were expected.
   */
  const zone = await clinicZone(branchId);
  // `startAt` IS an instant here — it came off the wire as a full timestamp — so which clinic day
  // it belongs to is a genuine zone question, unlike the named date in `getAvailability`.
  const dayKey = clinicDayKey(input.startAt, zone);
  const { from: clinicMidnight } = dayRangeInZone(dayKey, zone);

  const schedules = await repo.findSchedules(input.doctorId, weekdayOf(dayKey), branchId);
  const offered = schedules.flatMap((s) => slotsFor(clinicMidnight, s));
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

  // The doctor is on leave that day — the schedule would offer the slot, but they are away.
  if (await repo.isOnLeave(input.doctorId, clinicDayKey(slot.startAt, zone))) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      startAt: ["the doctor is on leave that day"],
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
          branchId,
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
          branchId,
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
      await assertToday(current.startAt, current.branchId);
      // The TOKEN is no longer issued here. It belongs to the Encounter (ADR-0013):
      // a walk-in has a token and no appointment, and in a government hospital that
      // is not an edge case — it is every patient. `checkInAppointment` creates the
      // encounter, which issues the token according to the hospital's policy.
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
          // From the RECORD, not the request: a cancellation is about the appointment's own
          // site, and the clerk cancelling it may be working at another one (ADR-0015).
          ...(updated.branchId ? { branchId: updated.branchId } : {}),
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

/**
 * The patient turned up for their booked slot — and THIS is where the appointment
 * stops being the centre of the world and hands over to the Encounter (ADR-0013).
 *
 * An appointment is a PROMISE of a visit. Check-in is the moment the promise is
 * kept: an Encounter is created (origin `appointment`), and from here on every note,
 * order, result and charge hangs on that, exactly as it does for a patient who
 * simply walked in.
 *
 * ── WHY THE ENCOUNTER IS CREATED BEFORE THE APPOINTMENT IS UPDATED ──────────
 * They cannot share one transaction: `startEncounter` opens its own, and nesting
 * two would either deadlock or leave an encounter committed by a transaction that
 * the appointment's then aborted.
 *
 * So they are sequenced, and the ORDER is chosen by which failure is survivable:
 *
 *   encounter first  → a crash leaves a patient IN THE QUEUE whose appointment
 *                      still says `confirmed`. They are in the building, the doctor
 *                      can see them, and re-running check-in RESUMES the same
 *                      encounter (the unique index sees to that) rather than making
 *                      a second. It converges.
 *   appointment first → a crash leaves an appointment marked `checked_in` with
 *                      nobody in the queue. The desk believes the patient was seen
 *                      to; the patient is sitting in the waiting room, invisible.
 *
 * The first is self-healing. The second loses the patient.
 */
export async function checkInAppointment(id: string): Promise<repo.Appointment> {
  const current = await repo.findById(id);
  if (!current) throw new AppError("HMS-GEN-404", 404, "Appointment not found", { id });
  if (!canTransition(current.status, "checked_in")) {
    throw invalidTransition(current.status, "checked_in");
  }
  await assertToday(current.startAt, current.branchId);

  const { encounter } = await startEncounter({
    patientId: current.patientId,
    origin: "appointment",
    doctorId: current.doctorId,
    appointmentId: current.id,
    ...(current.branchId ? { branchId: current.branchId } : {}),
    ...(current.reason ? { reason: current.reason } : {}),
  });

  return transition(id, "checked_in", undefined, { encounterId: encounter.id });
}

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
  const current = await repo.findById(id);
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
  const appointment = await repo.findById(id);
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
  /**
   * A schedule belongs to the SITE the doctor holds it at (ADR-0015): "Dr Rao, Mondays, Hyderabad"
   * and "Dr Rao, Mondays, Chennai" are two different clinics, and the unique key now says so.
   *
   * Through `writeBranchId` rather than straight from the body, for the reason the patient/
   * appointment/encounter/order paths already learned the hard way: a `branchId` in a request
   * body is a caller's instruction and must be checked against what that caller may reach, or a
   * receptionist confined to one site can rewrite another site's clinic hours.
   */
  const branchId = await writeBranchId(input.branchId);
  return repo.upsertSchedule({ ...input, ...(branchId ? { branchId } : {}) });
}

export const getDoctorSchedules = (doctorId: string): Promise<repo.DoctorSchedule[]> =>
  repo.findSchedules(doctorId);

export async function removeDoctorSchedule(id: string): Promise<void> {
  // Deactivated, never deleted: existing appointments were booked against it, and
  // "why was this patient given a 4pm slot" must remain answerable.
  const removed = await repo.deactivateSchedule(id);
  if (!removed) throw new AppError("HMS-GEN-404", 404, "Schedule not found", { id });
}

/* ── doctor availability (session roster) & leave (Doc 02 D2) ──────────────── */

export const getDoctorAvailability = (doctorId: string): Promise<repo.DoctorAvailability[]> =>
  repo.findAvailability(doctorId);

export async function setDoctorAvailability(input: {
  doctorId: string;
  weekday: number;
  sessions: repo.DoctorAvailability["sessions"];
  branchId?: string;
}): Promise<repo.DoctorAvailability | undefined> {
  // `full_day` already means the whole day, so pairing it with a part-session is
  // contradictory — collapse it to just `full_day` rather than reject and nag.
  const sessions = input.sessions.includes("full_day")
    ? (["full_day"] as repo.DoctorAvailability["sessions"])
    : [...new Set(input.sessions)];
  // Same key, same site rule, same reason as `setDoctorSchedule` — the roster is per branch.
  const branchId = await writeBranchId(input.branchId);
  return repo.setAvailability({ ...input, sessions, ...(branchId ? { branchId } : {}) });
}

export const getDoctorLeave = (doctorId: string): Promise<repo.DoctorLeave[]> =>
  repo.findLeave(doctorId);

export async function addDoctorLeave(input: {
  doctorId: string;
  fromDate: string;
  toDate: string;
  reason?: string;
  branchId?: string;
}): Promise<repo.DoctorLeave> {
  if (input.toDate < input.fromDate) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      toDate: ["leave cannot end before it starts"],
    });
  }
  // Leave is READ back through `scopeFilter`, so the branch it is stamped with decides who sees
  // it — which makes an unchecked body value a way to hide a doctor's absence from another site.
  const branchId = await writeBranchId(input.branchId);
  return repo.addLeave({ ...input, ...(branchId ? { branchId } : {}) });
}

export async function removeDoctorLeave(id: string): Promise<void> {
  const removed = await repo.removeLeave(id);
  if (!removed) throw new AppError("HMS-GEN-404", 404, "Leave not found", { id });
}

/**
 * A doctor cancelling their OWN leave.
 *
 * Identical to the administrator's version except that the doctor is part of the query, and the
 * failure is deliberately indistinguishable from "no such row" — see `repo.removeOwnLeave`.
 */
export async function removeOwnDoctorLeave(id: string, doctorId: string): Promise<void> {
  const removed = await repo.removeOwnLeave(id, doctorId);
  if (!removed) throw new AppError("HMS-GEN-404", 404, "Leave not found", { id });
}
