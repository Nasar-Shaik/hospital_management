/**
 * Ambulance + trip DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import {
  AMBULANCE_KINDS,
  AMBULANCE_TRIP_STATUSES,
  AMBULANCE_TRIP_PURPOSES,
} from "./ambulance.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

/* ── Ambulances ── */

export const createAmbulanceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    code: z.string().trim().min(1).max(24),
    registrationNumber: z.string().trim().min(1).max(32).optional(),
    kind: z.enum(AMBULANCE_KINDS),
  })
  .strict();

export const updateAmbulanceSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    registrationNumber: z.string().trim().min(1).max(32).optional(),
    kind: z.enum(AMBULANCE_KINDS).optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

/* ── Trips ── */

export const createTripSchema = z
  .object({
    ambulanceId: objectId,
    // The patient is OPTIONAL — an emergency dispatch to a scene precedes registration.
    patientId: objectId.optional(),
    encounterId: objectId.optional(),
    driverId: objectId.optional(),
    purpose: z.enum(AMBULANCE_TRIP_PURPOSES),
    pickup: z.string().trim().max(200).optional(),
    dropoff: z.string().trim().max(200).optional(),
    contactPhone: z.string().trim().max(20).optional(),
    scheduledStart: z.coerce.date(),
    scheduledEnd: z.coerce.date(),
  })
  .strict();

/** A trip can only be MOVED — a legal transition, checked against the state machine. */
export const transitionTripSchema = z
  .object({
    to: z.enum(AMBULANCE_TRIP_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/** The board query: a day window (defaults applied in the controller), optional vehicle/status. */
export const listTripsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    ambulanceId: objectId.optional(),
    status: z.enum(AMBULANCE_TRIP_STATUSES).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateAmbulanceBody = z.infer<typeof createAmbulanceSchema>;
export type UpdateAmbulanceBody = z.infer<typeof updateAmbulanceSchema>;
export type CreateTripBody = z.infer<typeof createTripSchema>;
export type TransitionTripBody = z.infer<typeof transitionTripSchema>;
export type ListTripsQuery = z.infer<typeof listTripsQuerySchema>;
