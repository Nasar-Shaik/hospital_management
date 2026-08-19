/**
 * Operating theatre response contracts.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { OT_BOOKING_STATUSES, THEATRE_KINDS, THEATRE_STATUSES } from "./theatre.model.js";
import type { Theatre } from "./theatre.repository.js";
import type { OtBookingView } from "./theatre.service.js";

export const theatre = contract(
  "Theatre",
  z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    kind: z.enum(THEATRE_KINDS),
    status: z.enum(THEATRE_STATUSES),
    branchId: z.string().optional(),
  }),
);
export type TheatreProof = Proves<Matches<typeof theatre, Theatre>>;

/** The booking WITH the patient's name and UHID resolved — the OT list's row. */
export const otBooking = contract(
  "OtBooking",
  z.object({
    id: z.string(),
    theatreId: z.string(),
    theatreName: z.string(),
    theatreCode: z.string(),
    patientId: z.string(),
    surgeonId: z.string(),
    encounterId: z.string().optional(),
    procedureName: z.string(),
    scheduledStart: z.string(),
    scheduledEnd: z.string(),
    status: z.enum(OT_BOOKING_STATUSES),
    notes: z.string().optional(),
    operativeNote: z
      .object({
        procedurePerformed: z.string(),
        surgeonId: z.string(),
        performedAt: z.string(),
        findings: z.string().optional(),
        notes: z.string().optional(),
        recordedBy: z.string().optional(),
        recordedAt: z.string(),
      })
      .optional(),
    branchId: z.string().optional(),
    patientName: z.string(),
    uhid: z.string(),
  }),
);
export type OtBookingProof = Proves<Matches<typeof otBooking, OtBookingView>>;
