/**
 * Ambulance + trip service (Module B6).
 *
 * The registry side is thin (turn a duplicate code into a sentence, a miss into a 404). The trip
 * side carries the module's real rules:
 *   - a trip's window must be well-formed (end after start) and land on an ACTIVE vehicle;
 *   - it must not OVERLAP another occupying trip on that vehicle (the collision rule);
 *   - its lifecycle moves only along legal edges (dispatched → in_progress → completed, or cancelled).
 * When a trip names a patient, the NAME on the board is joined here from the patient module — the
 * repository owns only its own two collections. A trip with no patient (an emergency to a scene) is
 * shown by its pickup, not a UHID.
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import { namesByIds } from "../patients/index.js";
import * as repo from "./ambulance.repository.js";
import { canTransition, type AmbulanceTripStatus } from "./ambulance.model.js";

export type { Ambulance, AmbulanceTrip } from "./ambulance.repository.js";

export const listAmbulances = repo.listAmbulances;
export const getAmbulance = repo.findAmbulanceById;

/* ── Ambulances ───────────────────────────────────────────────────────────────── */

export interface CreateAmbulanceInput {
  name: string;
  code: string;
  registrationNumber?: string;
  kind: repo.CreateAmbulanceInput["kind"];
}

export async function createAmbulance(input: CreateAmbulanceInput): Promise<repo.Ambulance> {
  try {
    return await repo.createAmbulance(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That ambulance code is already in use", {
        code: input.code,
        hint: "ambulance codes are unique per hospital — pick another",
      });
    }
    throw err;
  }
}

export async function updateAmbulance(
  id: string,
  patch: repo.UpdateAmbulanceInput,
): Promise<repo.Ambulance> {
  const existing = await repo.findAmbulanceById(id);
  if (!existing) throw new AppError("HMS-GEN-404", 404, "Ambulance not found", { id });
  const updated = await repo.updateAmbulance(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Ambulance not found", { id });
  return updated;
}

/* ── Trips ────────────────────────────────────────────────────────────────────── */

/** A trip on the board, with the patient named when there is one (there may not be). */
export interface AmbulanceTripView extends repo.AmbulanceTrip {
  patientName?: string;
  uhid?: string;
}

async function withPatients(trips: repo.AmbulanceTrip[]): Promise<AmbulanceTripView[]> {
  const ids = [...new Set(trips.map((t) => t.patientId).filter((v): v is string => Boolean(v)))];
  const names = ids.length ? await namesByIds(ids) : [];
  const byId = new Map(names.map((n) => [n.id, n]));
  return trips.map((t) => {
    if (!t.patientId) return { ...t };
    const found = byId.get(t.patientId);
    return {
      ...t,
      patientName: found?.name ?? "Unknown patient",
      uhid: found?.uhid ?? "—",
    };
  });
}

export interface ListTripsInput {
  from: Date;
  to: Date;
  ambulanceId?: string;
  status?: AmbulanceTripStatus;
}

export async function listTrips(input: ListTripsInput): Promise<AmbulanceTripView[]> {
  return withPatients(await repo.listTrips(input));
}

export interface CreateTripInput {
  ambulanceId: string;
  patientId?: string;
  encounterId?: string;
  driverId?: string;
  purpose: repo.CreateTripInput["purpose"];
  pickup?: string;
  dropoff?: string;
  contactPhone?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export async function createTrip(input: CreateTripInput): Promise<AmbulanceTripView> {
  if (input.scheduledEnd <= input.scheduledStart) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      scheduledEnd: ["the trip must end after it starts"],
    });
  }

  const vehicle = await repo.getAmbulanceDoc(input.ambulanceId);
  if (!vehicle)
    throw new AppError("HMS-GEN-404", 404, "Ambulance not found", { id: input.ambulanceId });
  if (vehicle.status !== "active") {
    throw new AppError("HMS-VAL-001", 409, "That ambulance is out of service", {
      ambulanceId: input.ambulanceId,
      hint: "pick an active vehicle",
    });
  }

  const clash = await repo.findOverlap(input.ambulanceId, input.scheduledStart, input.scheduledEnd);
  if (clash) {
    throw new AppError("HMS-VAL-001", 409, "That ambulance is already out for this window", {
      ambulance: vehicle.code,
      conflictsWith: clash.purpose,
      from: clash.scheduledStart,
      to: clash.scheduledEnd,
    });
  }

  const dispatchedBy = getContext().userId;
  try {
    const created = await repo.createTrip(
      { ...input, ...(dispatchedBy ? { dispatchedBy } : {}) },
      vehicle,
    );
    return (await withPatients([created]))[0]!;
  } catch (err) {
    // The race backstop fired: another identical dispatch won the same exact start (see the model
    // header). Report it as the same conflict the overlap check would have.
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That ambulance is already out for this window", {
        ambulance: vehicle.code,
        hint: "another dispatch just took this slot — refresh the board",
      });
    }
    throw err;
  }
}

export interface TransitionInput {
  to: AmbulanceTripStatus;
  reason?: string;
}

export async function transitionTrip(
  id: string,
  input: TransitionInput,
): Promise<AmbulanceTripView> {
  const trip = await repo.findTripDocById(id);
  if (!trip) throw new AppError("HMS-GEN-404", 404, "Trip not found", { id });

  if (!canTransition(trip.status, input.to)) {
    throw new AppError("HMS-VAL-001", 409, `Cannot move a ${trip.status} trip to ${input.to}`, {
      from: trip.status,
      to: input.to,
    });
  }

  const by = getContext().userId;
  const updated = await repo.setStatus(id, input.to, {
    from: trip.status,
    to: input.to,
    at: new Date(),
    ...(by ? { by } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Trip not found", { id });
  return (await withPatients([updated]))[0]!;
}
