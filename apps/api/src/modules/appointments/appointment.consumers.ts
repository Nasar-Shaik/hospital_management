/**
 * What the appointment book does when an appointment is booked or cancelled.
 *
 * The clinical policy — "a booking earns a confirmation now and a reminder the day
 * before" — lives HERE, with the module that owns the event, not inside the
 * notifications module (PLATFORM_STRATEGY Rule P1). A hospital that wants to change
 * that policy will come looking for the appointment book, and it will find it.
 */
import { createLogger } from "@medicore/logger";
import { env } from "../../config/env.js";
import { getContext } from "../../core/context/requestContext.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import { onPatientsMerged } from "../../core/events/patientMerge.js";
import { scheduleTask } from "../../core/events/taskQueue.js";
import type { DomainEvent, ModuleConsumers } from "../../core/events/consumers.js";
import { notify } from "../notifications/index.js";
import * as repo from "./appointment.repository.js";
import { getPatient } from "../patients/index.js";
import { getById as getUser } from "../users/index.js";
import { getById as getTenant } from "../tenants/index.js";
import { getAppointment } from "./appointment.service.js";
import { occupiesSlot } from "./appointment.model.js";

const logger = createLogger({ service: "appointment-consumers" });

/** The reminder task name, and the hour it fires before the appointment. */
const REMINDER_TASK = "appointment.reminder";
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Renders an appointment time the way a patient reads one.
 *
 * In the hospital's timezone, never UTC (env.DEFAULT_TIMEZONE) — a reminder that
 * says "09:00" when the clinic means 14:30 is worse than sending nothing at all.
 */
function formatWhen(startAt: Date): { date: string; time: string } {
  const zone = env.DEFAULT_TIMEZONE;
  return {
    date: new Intl.DateTimeFormat("en-IN", {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(startAt),
    time: new Intl.DateTimeFormat("en-IN", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(startAt),
  };
}

/** The fields every appointment message needs. Undefined when the appointment is gone. */
async function messageData(appointmentId: string): Promise<
  | {
      data: Record<string, string>;
      patient: { id: string; name: string; email?: string };
      branchId?: string;
    }
  | undefined
> {
  const appointment = await getAppointment(appointmentId);
  if (!appointment) return undefined;

  const patient = await getPatient(appointment.patientId);
  if (!patient) return undefined;

  const ctx = getContext();
  const [doctor, tenant] = await Promise.all([
    getUser(appointment.doctorId),
    getTenant(ctx.tenantId),
  ]);

  const when = formatWhen(appointment.startAt);

  return {
    data: {
      name: patient.name,
      uhid: patient.uhid,
      // A doctor deleted from the system must not blank out the sentence — a
      // patient reading "Your appointment with  on Monday" assumes we are broken.
      doctor: doctor?.name ?? "your doctor",
      hospital: tenant?.hospitalName ?? "",
      date: when.date,
      time: when.time,
    },
    patient: {
      id: patient.id,
      name: patient.name,
      ...(patient.contact.email ? { email: patient.contact.email } : {}),
    },
    ...(appointment.branchId ? { branchId: appointment.branchId } : {}),
  };
}

/**
 * Booked: confirm now, and schedule the reminder for the day before.
 *
 * The reminder is the highest-value message in the product. A reminder that lands
 * is a no-show that does not happen, and an empty slot is revenue a hospital can
 * never recover — the doctor was paid for that half hour either way.
 */
async function onAppointmentBooked(event: DomainEvent): Promise<void> {
  const appointmentId = String(event.payload.appointmentId ?? "");
  const context = await messageData(appointmentId);
  if (!context) {
    logger.info({ appointmentId }, "appointment no longer resolvable — nothing sent");
    return;
  }

  await notify({
    templateKey: "appointment.confirmation",
    recipient: {
      ...(context.patient.email ? { address: context.patient.email } : {}),
      name: context.patient.name,
      type: "patient",
      id: context.patient.id,
    },
    data: context.data,
    // One confirmation per appointment. Keyed on the appointment rather than the
    // event, so a replayed event confirms nothing twice.
    dedupeKey: `appointment.confirmation:${appointmentId}`,
    eventId: event.eventId,
    ...(context.branchId ? { branchId: context.branchId } : {}),
  });

  await scheduleReminder(appointmentId, event.tenantId, new Date(String(event.payload.startAt)));
}

/**
 * ── THE DELAYED JOB IS A TRIGGER; THE DATABASE IS THE TRUTH ─────────────────
 *
 * We schedule a reminder for 24h before the appointment and then never touch it
 * again — not when the patient cancels, not when the clerk reschedules, not when
 * the doctor's clinic moves. There is no job to find and cancel, because the job
 * does not carry the decision. It carries an appointment ID, and the handler
 * re-reads the appointment when it fires.
 *
 * The alternative — cancelling and rescheduling the Redis job on every state change
 * — sounds tidier and is a trap: it puts the decision in two places (a durable
 * database and a volatile queue) and makes correctness depend on them agreeing.
 * They will not agree. A Redis flush, a missed cancel, a reschedule that races the
 * fire time, and a patient is reminded to attend an appointment that no longer
 * exists. Re-reading costs one query and cannot get this wrong.
 */
async function scheduleReminder(
  appointmentId: string,
  tenantId: string,
  startAt: Date,
): Promise<void> {
  const delayMs = startAt.getTime() - REMINDER_LEAD_MS - Date.now();

  if (delayMs <= 0) {
    // Booked inside the reminder window — they are standing at the desk, or they
    // booked this morning for tomorrow. The confirmation they just received IS the
    // reminder; a second message an hour later is spam.
    logger.debug({ appointmentId }, "booked within 24h of the slot — no reminder scheduled");
    return;
  }

  await scheduleTask(
    REMINDER_TASK,
    tenantId,
    { appointmentId },
    {
      delayMs,
      // BullMQ refuses a duplicate job id, so a redelivered `appointment.booked`
      // (at-least-once — it will happen) schedules no second reminder.
      jobId: `reminder:${tenantId}:${appointmentId}`,
    },
  );
}

/**
 * Fires the day before. Re-reads the appointment and decides then.
 *
 * `occupiesSlot` is the same predicate that decides whether an appointment holds a
 * doctor's time in the unique index (appointment.model.ts). Reusing it means the
 * question "is this appointment still happening?" has exactly one answer in this
 * codebase — a cancelled, rescheduled, completed or no-showed appointment does not
 * occupy a slot, and does not get reminded about.
 */
async function onReminderDue(data: Record<string, unknown>): Promise<void> {
  const appointmentId = String(data.appointmentId ?? "");
  const appointment = await getAppointment(appointmentId);

  if (!appointment) {
    logger.info({ appointmentId }, "reminder fired for an appointment that is gone — skipped");
    return;
  }

  if (!occupiesSlot(appointment.status)) {
    // Cancelled or rescheduled between booking and now. THIS is the line that means
    // no patient is ever reminded to attend an appointment that is not happening —
    // and the reason cancel/reschedule need no job-cancellation logic at all.
    logger.info(
      { appointmentId, status: appointment.status },
      "appointment no longer active — reminder skipped",
    );
    return;
  }

  const context = await messageData(appointmentId);
  if (!context) return;

  await notify({
    templateKey: "appointment.reminder",
    recipient: {
      ...(context.patient.email ? { address: context.patient.email } : {}),
      name: context.patient.name,
      type: "patient",
      id: context.patient.id,
    },
    data: context.data,
    // Exactly one reminder per appointment, even if the task is retried or the
    // appointment is rescheduled onto a new slot (which books a NEW appointment
    // with its own id, and so earns its own reminder).
    dedupeKey: `appointment.reminder:${appointmentId}`,
    ...(context.branchId ? { branchId: context.branchId } : {}),
  });
}

/** Cancelled: tell the patient. Silence here is how a patient turns up anyway. */
async function onAppointmentCancelled(event: DomainEvent): Promise<void> {
  const appointmentId = String(event.payload.appointmentId ?? "");
  const context = await messageData(appointmentId);
  if (!context) return;

  await notify({
    templateKey: "appointment.cancellation",
    recipient: {
      ...(context.patient.email ? { address: context.patient.email } : {}),
      name: context.patient.name,
      type: "patient",
      id: context.patient.id,
    },
    data: {
      ...context.data,
      reason: typeof event.payload.reason === "string" ? event.payload.reason : "",
    },
    dedupeKey: `appointment.cancellation:${appointmentId}`,
    eventId: event.eventId,
    ...(context.branchId ? { branchId: context.branchId } : {}),
  });
}

export const appointmentConsumers: ModuleConsumers = {
  events: {
    [EVENTS.APPOINTMENT_BOOKED]: onAppointmentBooked,
    [EVENTS.APPOINTMENT_CANCELLED]: onAppointmentCancelled,
    [EVENTS.PATIENTS_MERGED]: onPatientsMerged("appointments", repo.repointPatient),
  },
  tasks: {
    [REMINDER_TASK]: onReminderDue,
  },
};
