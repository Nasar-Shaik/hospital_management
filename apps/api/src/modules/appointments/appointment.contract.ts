/**
 * Appointment and doctor-calendar response contracts.
 *
 * Every shape here carries `branchId` (ADR-0015). A doctor holds a Monday clinic in Hyderabad and
 * another in Chennai; a schedule that does not say which site it belongs to is not a schedule.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { APPOINTMENT_STATUSES, DOCTOR_SESSIONS } from "./appointment.model.js";
import type {
  Appointment,
  DoctorAvailability,
  DoctorLeave,
  DoctorSchedule,
} from "./appointment.repository.js";
import type { Slot } from "./slots.js";

const appointmentStatus = z.enum(APPOINTMENT_STATUSES);

/** One transition in the appointment's life, kept so the desk can see who changed what. */
export const statusChange = contract(
  "AppointmentStatusChange",
  z.object({
    from: appointmentStatus,
    to: appointmentStatus,
    at: z.string(),
    by: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export const appointment = contract(
  "Appointment",
  z.object({
    id: z.string(),
    patientId: z.string(),
    doctorId: z.string(),
    branchId: z.string().optional(),
    departmentId: z.string().optional(),
    startAt: z.string(),
    endAt: z.string(),
    status: appointmentStatus,
    reason: z.string().optional(),
    /** The Encounter this became at check-in (ADR-0013). The token lives on the encounter. */
    encounterId: z.string().optional(),
    /** Set on the retired appointment when it was rescheduled. */
    rescheduledTo: z.string().optional(),
    statusHistory: z.array(statusChange),
    createdAt: z.string(),
  }),
);
export type AppointmentProof = Proves<Matches<typeof appointment, Appointment>>;

/** A bookable slot. Computed per day from the doctor's weekly template — never stored. */
export const slot = contract("Slot", z.object({ startAt: z.string(), endAt: z.string() }));
export type SlotProof = Proves<Matches<typeof slot, Slot>>;

/** Reschedule retires one appointment and books another; the client needs both. */
export const rescheduleResult = contract(
  "RescheduleResult",
  z.object({ cancelled: appointment, booked: appointment }),
);

export const doctorSchedule = contract(
  "DoctorSchedule",
  z.object({
    id: z.string(),
    doctorId: z.string(),
    branchId: z.string().optional(),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: z.number(),
    /** Minutes from local midnight. 540 = 09:00. */
    startMinute: z.number(),
    endMinute: z.number(),
    slotMinutes: z.number(),
    active: z.boolean(),
  }),
);
export type DoctorScheduleProof = Proves<Matches<typeof doctorSchedule, DoctorSchedule>>;

export const doctorAvailability = contract(
  "DoctorAvailability",
  z.object({
    doctorId: z.string(),
    weekday: z.number(),
    sessions: z.array(z.enum(DOCTOR_SESSIONS)),
    branchId: z.string().optional(),
  }),
);
export type DoctorAvailabilityProof = Proves<
  Matches<typeof doctorAvailability, DoctorAvailability>
>;

export const doctorLeave = contract(
  "DoctorLeave",
  z.object({
    id: z.string(),
    doctorId: z.string(),
    branchId: z.string().optional(),
    fromDate: z.string(),
    toDate: z.string(),
    reason: z.string().optional(),
  }),
);
export type DoctorLeaveProof = Proves<Matches<typeof doctorLeave, DoctorLeave>>;

export const removedAck = contract("RemovedAck", z.object({ removed: z.literal(true) }));
