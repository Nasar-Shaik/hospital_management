/**
 * Theatre & OT-booking DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { THEATRE_KINDS, OT_BOOKING_STATUSES } from "./theatre.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/* ── Theatres ── */

export const createTheatreSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    code: z.string().trim().min(1).max(24),
    kind: z.enum(THEATRE_KINDS),
  })
  .strict();

export const updateTheatreSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(THEATRE_KINDS).optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

/* ── OT bookings ── */

export const createBookingSchema = z
  .object({
    theatreId: objectId,
    patientId: objectId,
    surgeonId: objectId,
    encounterId: objectId.optional(),
    procedureName: z.string().trim().min(1).max(200),
    scheduledStart: z.coerce.date(),
    scheduledEnd: z.coerce.date(),
  })
  .strict();

/** A booking can only be MOVED — a legal transition, checked against the state machine. */
export const transitionBookingSchema = z
  .object({
    to: z.enum(OT_BOOKING_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/** The board query: a day window (defaults applied in the controller), optional theatre/status. */
export const listBookingsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    theatreId: objectId.optional(),
    status: z.enum(OT_BOOKING_STATUSES).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateTheatreBody = z.infer<typeof createTheatreSchema>;
export type UpdateTheatreBody = z.infer<typeof updateTheatreSchema>;
export type CreateBookingBody = z.infer<typeof createBookingSchema>;
export type TransitionBookingBody = z.infer<typeof transitionBookingSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
