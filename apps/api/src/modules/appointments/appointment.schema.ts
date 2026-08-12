/**
 * Appointment DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { APPOINTMENT_STATUSES, DOCTOR_SESSIONS } from "./appointment.model.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const bookAppointmentSchema = z
  .object({
    patientId: objectId,
    doctorId: objectId,
    /** Must be the exact start of a slot the doctor's schedule offers. */
    startAt: z.coerce.date(),
    branchId: objectId.optional(),
    departmentId: objectId.optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const availabilityQuerySchema = z
  .object({
    doctorId: objectId,
    /** The day being viewed. Slots are computed, never stored (see slots.ts). */
    date: z.coerce.date(),
  })
  .strict();

export const listAppointmentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    doctorId: objectId.optional(),
    patientId: objectId.optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

/**
 * A cancellation reason is REQUIRED, and that is a product decision, not a
 * validation preference. "Cancelled" with no why is useless to the doctor whose
 * list just shrank, to the patient asking what happened, and to the waiting-list
 * logic that wants to know whether the slot is genuinely free.
 */
export const cancelAppointmentSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

export const rescheduleAppointmentSchema = z
  .object({
    startAt: z.coerce.date(),
    reason: z.string().min(3).max(500),
  })
  .strict();

export const noShowSchema = z.object({ reason: z.string().max(500).optional() }).strict();

export const setScheduleSchema = z
  .object({
    doctorId: objectId,
    /** 0 = Sunday … 6 = Saturday. */
    weekday: z.number().int().min(0).max(6),
    /** Minutes from local midnight. 540 = 09:00. */
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    slotMinutes: z.number().int().min(5).max(240),
    branchId: objectId.optional(),
  })
  .strict();

/**
 * The doctor's weekly session roster (Doc 02 D2). Sessions may be EMPTY — that clears the
 * weekday ("not in"). `.strict()` still rejects unknown fields.
 */
export const setAvailabilitySchema = z
  .object({
    doctorId: objectId,
    /** 0 = Sunday … 6 = Saturday. */
    weekday: z.number().int().min(0).max(6),
    sessions: z.array(z.enum(DOCTOR_SESSIONS)).max(4),
    branchId: objectId.optional(),
  })
  .strict();

/** A block of days a doctor is away — inclusive `fromDate`..`toDate`. */
export const addLeaveSchema = z
  .object({
    doctorId: objectId,
    fromDate: isoDate,
    toDate: isoDate,
    reason: z.string().trim().max(200).optional(),
    branchId: objectId.optional(),
  })
  .strict();

/**
 * ── THE SELF-SERVICE BODIES CARRY NO `doctorId`, AND THAT IS THE CONTROL ────
 * These back `/doctors/me/…`, where the doctor is taken from the authenticated token. Omitting the
 * field is stronger than validating it: `.strict()` means a body that tries to name a doctor is
 * REJECTED rather than quietly ignored, so there is no id to tamper with and no branch of code
 * that has to remember to check one.
 */
export const setOwnAvailabilitySchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    sessions: z.array(z.enum(DOCTOR_SESSIONS)).max(4),
    branchId: objectId.optional(),
  })
  .strict();

export const addOwnLeaveSchema = z
  .object({
    fromDate: isoDate,
    toDate: isoDate,
    reason: z.string().trim().max(200).optional(),
    branchId: objectId.optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();
export const doctorIdParamSchema = z.object({ doctorId: objectId }).strict();

export type BookAppointmentBody = z.infer<typeof bookAppointmentSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
export type SetScheduleBody = z.infer<typeof setScheduleSchema>;
export type SetAvailabilityBody = z.infer<typeof setAvailabilitySchema>;
export type AddLeaveBody = z.infer<typeof addLeaveSchema>;
export type SetOwnAvailabilityBody = z.infer<typeof setOwnAvailabilitySchema>;
export type AddOwnLeaveBody = z.infer<typeof addOwnLeaveSchema>;
