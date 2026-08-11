/**
 * Ambulance response contracts — the fleet and its trips.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import {
  AMBULANCE_KINDS,
  AMBULANCE_STATUSES,
  AMBULANCE_TRIP_PURPOSES,
  AMBULANCE_TRIP_STATUSES,
} from "./ambulance.model.js";
import type { Ambulance } from "./ambulance.repository.js";
import type { AmbulanceTripView } from "./ambulance.service.js";

export const ambulance = contract(
  "Ambulance",
  z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    registrationNumber: z.string().optional(),
    kind: z.enum(AMBULANCE_KINDS),
    status: z.enum(AMBULANCE_STATUSES),
    branchId: z.string().optional(),
  }),
);
export type AmbulanceProof = Proves<Matches<typeof ambulance, Ambulance>>;

/** The trip WITH the patient's name and UHID resolved — the dispatch board's row. */
export const ambulanceTrip = contract(
  "AmbulanceTrip",
  z.object({
    id: z.string(),
    ambulanceId: z.string(),
    /** Denormalized, so the board reads without a second call. */
    ambulanceName: z.string(),
    ambulanceCode: z.string(),
    patientId: z.string().optional(),
    encounterId: z.string().optional(),
    driverId: z.string().optional(),
    purpose: z.enum(AMBULANCE_TRIP_PURPOSES),
    pickup: z.string().optional(),
    dropoff: z.string().optional(),
    contactPhone: z.string().optional(),
    scheduledStart: z.string(),
    scheduledEnd: z.string(),
    status: z.enum(AMBULANCE_TRIP_STATUSES),
    notes: z.string().optional(),
    branchId: z.string().optional(),
    patientName: z.string().optional(),
    uhid: z.string().optional(),
  }),
);
export type AmbulanceTripProof = Proves<Matches<typeof ambulanceTrip, AmbulanceTripView>>;
