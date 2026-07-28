/**
 * Ambulance + trip repository — the ONLY code that queries `ambulances` / `ambulanceTrips`
 * (Constitution §6).
 *
 * Branch-aware, like the theatre inventory: reads pass through `scopeFilter()` (a user confined to
 * one site sees only its vehicles and its board) and writes stamp the active `branchId`
 * (`writeBranchId`). Occupancy of a vehicle WINDOW is not stored — it is the set of occupying trips,
 * which is what `findOverlap` reads.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getAmbulanceModel,
  getAmbulanceTripModel,
  occupiesVehicle,
  type AmbulanceDoc,
  type AmbulanceTripDoc,
  type AmbulanceKind,
  type AmbulanceStatus,
  type AmbulanceTripStatus,
  type AmbulanceTripPurpose,
  type AmbulanceTripStatusChange,
} from "./ambulance.model.js";

export { isDuplicateKey };

/* ── Ambulances (vehicles) ────────────────────────────────────────────────────── */

export interface Ambulance {
  id: string;
  name: string;
  code: string;
  registrationNumber?: string;
  kind: AmbulanceKind;
  status: AmbulanceStatus;
  branchId?: string;
}

function toAmbulance(doc: AmbulanceDoc): Ambulance {
  return {
    id: doc._id.toString(),
    name: doc.name,
    code: doc.code,
    ...(doc.registrationNumber ? { registrationNumber: doc.registrationNumber } : {}),
    kind: doc.kind,
    status: doc.status,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateAmbulanceInput {
  name: string;
  code: string;
  registrationNumber?: string;
  kind: AmbulanceKind;
}

export async function createAmbulance(input: CreateAmbulanceInput): Promise<Ambulance> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getAmbulanceModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    code: input.code.toUpperCase(),
    ...(input.registrationNumber ? { registrationNumber: input.registrationNumber } : {}),
    kind: input.kind,
    ...(branchId ? { branchId } : {}),
  });
  return toAmbulance(doc.toObject() as AmbulanceDoc);
}

export async function listAmbulances(): Promise<Ambulance[]> {
  const docs = await getAmbulanceModel(getTenantDb())
    .find({ ...scopeFilter() })
    .sort({ code: 1 })
    .lean<AmbulanceDoc[]>();
  return docs.map(toAmbulance);
}

export async function findAmbulanceById(id: string): Promise<Ambulance | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAmbulanceModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<AmbulanceDoc>();
  return doc ? toAmbulance(doc) : undefined;
}

export interface UpdateAmbulanceInput {
  name?: string;
  registrationNumber?: string;
  kind?: AmbulanceKind;
  status?: AmbulanceStatus;
}

export async function updateAmbulance(
  id: string,
  patch: UpdateAmbulanceInput,
): Promise<Ambulance | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAmbulanceModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<AmbulanceDoc>();
  return doc ? toAmbulance(doc) : undefined;
}

/** The raw doc — the dispatch path reads this to check the vehicle is real and active. */
export async function getAmbulanceDoc(id: string): Promise<AmbulanceDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAmbulanceModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<AmbulanceDoc>();
  return doc ?? undefined;
}

/* ── Trips ────────────────────────────────────────────────────────────────────── */

export interface AmbulanceTrip {
  id: string;
  ambulanceId: string;
  ambulanceName: string;
  ambulanceCode: string;
  patientId?: string;
  encounterId?: string;
  driverId?: string;
  purpose: AmbulanceTripPurpose;
  pickup?: string;
  dropoff?: string;
  contactPhone?: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: AmbulanceTripStatus;
  notes?: string;
  branchId?: string;
}

function toTrip(doc: AmbulanceTripDoc, vehicle?: AmbulanceDoc): AmbulanceTrip {
  return {
    id: doc._id.toString(),
    ambulanceId: doc.ambulanceId.toString(),
    ambulanceName: vehicle?.name ?? "—",
    ambulanceCode: vehicle?.code ?? "—",
    ...(doc.patientId ? { patientId: doc.patientId } : {}),
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    ...(doc.driverId ? { driverId: doc.driverId } : {}),
    purpose: doc.purpose,
    ...(doc.pickup ? { pickup: doc.pickup } : {}),
    ...(doc.dropoff ? { dropoff: doc.dropoff } : {}),
    ...(doc.contactPhone ? { contactPhone: doc.contactPhone } : {}),
    scheduledStart: doc.scheduledStart.toISOString(),
    scheduledEnd: doc.scheduledEnd.toISOString(),
    status: doc.status,
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateTripInput {
  ambulanceId: string;
  patientId?: string;
  encounterId?: string;
  driverId?: string;
  purpose: AmbulanceTripPurpose;
  pickup?: string;
  dropoff?: string;
  contactPhone?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  dispatchedBy?: string;
}

export async function createTrip(
  input: CreateTripInput,
  vehicle: AmbulanceDoc,
): Promise<AmbulanceTrip> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getAmbulanceTripModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    ambulanceId: vehicle._id,
    ...(input.patientId ? { patientId: input.patientId } : {}),
    ...(input.encounterId ? { encounterId: new Types.ObjectId(input.encounterId) } : {}),
    ...(input.driverId ? { driverId: input.driverId } : {}),
    purpose: input.purpose,
    ...(input.pickup ? { pickup: input.pickup } : {}),
    ...(input.dropoff ? { dropoff: input.dropoff } : {}),
    ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    status: "dispatched",
    occupies: true, // a fresh trip holds its window (occupiesVehicle("dispatched") === true)
    ...(input.dispatchedBy ? { dispatchedBy: input.dispatchedBy } : {}),
    // A trip inherits its vehicle's branch: they are the same operational unit.
    ...(vehicle.branchId ? { branchId: vehicle.branchId } : branchId ? { branchId } : {}),
  });
  return toTrip(doc.toObject() as AmbulanceTripDoc, vehicle);
}

/** The raw trip doc — the transition path reads this to check the state machine. */
export async function findTripDocById(id: string): Promise<AmbulanceTripDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getAmbulanceTripModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<AmbulanceTripDoc>();
  return doc ?? undefined;
}

/**
 * The first OCCUPYING trip on this vehicle whose window overlaps [start, end), excluding `exceptId`.
 * This IS the collision rule — two windows overlap when each starts before the other ends. Returns
 * the conflict so the caller can name it in the error.
 */
export async function findOverlap(
  ambulanceId: string,
  start: Date,
  end: Date,
  exceptId?: string,
): Promise<AmbulanceTrip | undefined> {
  if (!Types.ObjectId.isValid(ambulanceId)) return undefined;
  const db = getTenantDb();
  const clash = await getAmbulanceTripModel(db)
    .findOne({
      ...scopeFilter(),
      ambulanceId: new Types.ObjectId(ambulanceId),
      occupies: true,
      scheduledStart: { $lt: end },
      scheduledEnd: { $gt: start },
      ...(exceptId && Types.ObjectId.isValid(exceptId)
        ? { _id: { $ne: new Types.ObjectId(exceptId) } }
        : {}),
    })
    .lean<AmbulanceTripDoc>();
  if (!clash) return undefined;
  const vehicle = await getAmbulanceModel(db).findById(clash.ambulanceId).lean<AmbulanceDoc>();
  return toTrip(clash, vehicle ?? undefined);
}

/**
 * The dispatch board: trips whose window intersects [from, to), scoped, oldest first, each joined to
 * its vehicle. One query per collection, joined in memory — a fleet's day is small.
 */
export async function listTrips(filter: {
  from: Date;
  to: Date;
  ambulanceId?: string;
  status?: AmbulanceTripStatus;
}): Promise<AmbulanceTrip[]> {
  const db = getTenantDb();
  const q: Record<string, unknown> = {
    ...scopeFilter(),
    scheduledStart: { $lt: filter.to },
    scheduledEnd: { $gt: filter.from },
  };
  if (filter.ambulanceId && Types.ObjectId.isValid(filter.ambulanceId)) {
    q.ambulanceId = new Types.ObjectId(filter.ambulanceId);
  }
  if (filter.status) q.status = filter.status;

  const [trips, vehicles] = await Promise.all([
    getAmbulanceTripModel(db).find(q).sort({ scheduledStart: 1 }).lean<AmbulanceTripDoc[]>(),
    getAmbulanceModel(db)
      .find({ ...scopeFilter() })
      .lean<AmbulanceDoc[]>(),
  ]);
  const byId = new Map(vehicles.map((v) => [v._id.toString(), v]));
  return trips.map((t) => toTrip(t, byId.get(t.ambulanceId.toString())));
}

/**
 * Applies a state transition: writes the new status, appends the history line, and MAINTAINS
 * `occupies` in the one place it is ever set — present while the trip holds its window, unset the
 * instant it releases it (so a cancelled trip frees the vehicle for the overlap check). Mirrors the
 * theatre module's `setStatus`.
 */
export async function setStatus(
  id: string,
  to: AmbulanceTripStatus,
  change: AmbulanceTripStatusChange,
): Promise<AmbulanceTrip | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const set: Record<string, unknown> = { status: to };
  const unset: Record<string, unknown> = {};
  if (occupiesVehicle(to)) set.occupies = true;
  else unset.occupies = "";

  const doc = await getAmbulanceTripModel(db)
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $push: { statusHistory: change },
      },
      { new: true },
    )
    .lean<AmbulanceTripDoc>();
  if (!doc) return undefined;
  const vehicle = await getAmbulanceModel(db).findById(doc.ambulanceId).lean<AmbulanceDoc>();
  return toTrip(doc, vehicle ?? undefined);
}
