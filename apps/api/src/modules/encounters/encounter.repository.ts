/**
 * Encounter repository — the ONLY code that queries `encounters` and
 * `episodesOfCare` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getEncounterModel,
  getEpisodeModel,
  isOpen,
  type EncounterClass,
  type EncounterDoc,
  type EncounterHistoryEntry,
  type EncounterOrigin,
  type EncounterStatus,
} from "./encounter.model.js";

export { isDuplicateKey };

/** What leaves the module. Never the raw Mongoose document (Doc 09 §5). */
export interface Encounter {
  id: string;
  patientId: string;
  episodeId: string;
  origin: EncounterOrigin;
  class: EncounterClass;
  status: EncounterStatus;
  appointmentId?: string;
  doctorId?: string;
  departmentId?: string;
  token?: number;
  reason?: string;
  branchId?: string;
  arrivedAt: Date;
  closedAt?: Date;
  history: EncounterHistoryEntry[];
  createdAt: Date;
}

function toEncounter(doc: EncounterDoc): Encounter {
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    origin: doc.origin,
    class: doc.class,
    status: doc.status,
    arrivedAt: doc.arrivedAt,
    history: doc.history ?? [],
    createdAt: doc.createdAt,
    ...(doc.appointmentId ? { appointmentId: doc.appointmentId.toString() } : {}),
    ...(doc.doctorId ? { doctorId: doc.doctorId } : {}),
    ...(doc.departmentId ? { departmentId: doc.departmentId } : {}),
    ...(doc.token !== undefined ? { token: doc.token } : {}),
    ...(doc.reason ? { reason: doc.reason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    ...(doc.closedAt ? { closedAt: doc.closedAt } : {}),
  };
}

/**
 * The next token for a queue, today.
 *
 * An atomic `$inc` on a per-day, per-queue counter — the same mechanism that issues
 * UHIDs, and for the same reason: two clerks registering two walk-ins at the same
 * instant must not both be told "token 42". A read-then-write cannot promise that;
 * only the database can.
 *
 * The counter id is scoped by DAY, so numbering restarts each morning — which is
 * what a token means to a patient ("I am number 12 today"), and it keeps the number
 * small enough to shout across a waiting room.
 *
 * It is scoped by QUEUE (the doctor, or the department/OP room) because a
 * government hospital runs several OP rooms in parallel and each calls its own
 * numbers. One shared counter would hand OP-1 token 3 and OP-2 token 4, and the
 * board would be nonsense.
 */
export async function nextToken(queueKey: string, session?: ClientSession): Promise<number> {
  const ctx = getContext();
  const day = new Date().toISOString().slice(0, 10);

  const result = await ctx.connection
    .collection<{ _id: string; tenantId: string; seq: number }>("counters")
    .findOneAndUpdate(
      { _id: `token:${day}:${queueKey}` },
      { $inc: { seq: 1 }, $setOnInsert: { tenantId: ctx.tenantId } },
      { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
    );

  const seq = result?.seq;
  if (typeof seq !== "number") {
    throw new Error("token allocation failed — refusing to queue a patient without a token");
  }
  return seq;
}

export interface CreateEncounterInput {
  patientId: string;
  episodeId: string;
  origin: EncounterOrigin;
  class: EncounterClass;
  status: EncounterStatus;
  appointmentId?: string;
  doctorId?: string;
  departmentId?: string;
  token?: number;
  reason?: string;
  branchId?: string;
}

/**
 * Inserts the encounter. Throws a duplicate-key error when the patient ALREADY has
 * one open — by design.
 *
 * "One open encounter per patient" is enforced by a unique partial index
 * (migration 0012), not by a check, because a check cannot win the race between two
 * clerks registering the same returning patient at two desks. The service catches
 * the duplicate key and hands back the encounter that already exists, which is what
 * the clerk actually wanted: the patient is already here.
 */
export async function create(
  input: CreateEncounterInput,
  session: ClientSession,
): Promise<Encounter> {
  const ctx = getContext();

  const [doc] = await getEncounterModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        patientId: new Types.ObjectId(input.patientId),
        episodeId: new Types.ObjectId(input.episodeId),
        origin: input.origin,
        class: input.class,
        status: input.status,
        arrivedAt: new Date(),
        history: [],
        // Derived, never passed in — see the model. This is what the unique index
        // watches.
        ...(isOpen(input.status) ? { open: true as const } : {}),
        ...(input.appointmentId ? { appointmentId: new Types.ObjectId(input.appointmentId) } : {}),
        ...(input.doctorId ? { doctorId: input.doctorId } : {}),
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(ctx.userId ? { createdBy: ctx.userId } : {}),
      },
    ],
    { session },
  );

  if (!doc) throw new Error("encounter insert returned nothing");
  return toEncounter(doc);
}

/** The patient's currently-open encounter, if they are in the building. */
export async function findOpenForPatient(patientId: string): Promise<Encounter | undefined> {
  const doc = await getEncounterModel(getTenantDb())
    .findOne({ patientId: new Types.ObjectId(patientId), open: true })
    .lean<EncounterDoc>();
  return doc ? toEncounter(doc) : undefined;
}

export async function findById(id: string): Promise<Encounter | undefined> {
  const doc = await getEncounterModel(getTenantDb())
    .findOne({ _id: id, ...scopeFilter() })
    .lean<EncounterDoc>();
  return doc ? toEncounter(doc) : undefined;
}

/**
 * Moves the encounter, and maintains `open` IN THE SAME WRITE.
 *
 * The two must never be set separately: an encounter that is `closed` but still
 * flagged `open` holds the patient's only slot forever and they can never be
 * registered again. Same discipline as `appointments.occupies`.
 */
export async function setStatus(
  id: string,
  to: EncounterStatus,
  entry: EncounterHistoryEntry,
  session: ClientSession,
  alsoSet: Record<string, unknown> = {},
): Promise<Encounter | undefined> {
  const nowOpen = isOpen(to);

  const doc = await getEncounterModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: to,
          ...alsoSet,
          ...(nowOpen ? { open: true } : {}),
          ...(to === "closed" || to === "admitted" ? { closedAt: new Date() } : {}),
        },
        // Terminal: the key is REMOVED, not set to false. A stored `false` sits in
        // the unique partial index and locks the patient out of ever returning.
        ...(nowOpen ? {} : { $unset: { open: 1 } }),
        $push: { history: entry },
      },
      { new: true, session },
    )
    .lean<EncounterDoc>();

  return doc ? toEncounter(doc) : undefined;
}

export interface ListEncountersFilter {
  status?: EncounterStatus;
  doctorId?: string;
  departmentId?: string;
  patientId?: string;
  /** The queue board: everyone currently waiting or being seen. */
  queuedOnly?: boolean;
  limit: number;
  skip: number;
}

export async function list(
  filter: ListEncountersFilter,
): Promise<{ items: Encounter[]; total: number }> {
  const model = getEncounterModel(getTenantDb());

  const query: Record<string, unknown> = {
    ...scopeFilter(),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.doctorId ? { doctorId: filter.doctorId } : {}),
    ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
    ...(filter.patientId ? { patientId: new Types.ObjectId(filter.patientId) } : {}),
    ...(filter.queuedOnly
      ? { status: { $in: ["in_queue", "in_progress", "awaiting_results"] } }
      : {}),
  };

  const [docs, total] = await Promise.all([
    model
      // The queue is called in TOKEN order — which is arrival order, which is the
      // only order a waiting room will accept as fair.
      .find(query)
      .sort(filter.queuedOnly ? { token: 1 } : { arrivedAt: -1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<EncounterDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toEncounter), total };
}

/* ── Episodes of care ─────────────────────────────────────────────────────── */

export async function createEpisode(
  patientId: string,
  session: ClientSession,
  reason?: string,
): Promise<string> {
  const ctx = getContext();

  const [doc] = await getEpisodeModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        patientId: new Types.ObjectId(patientId),
        status: "active",
        startedAt: new Date(),
        ...(reason ? { reason } : {}),
      },
    ],
    { session },
  );

  if (!doc) throw new Error("episode insert returned nothing");
  return doc._id.toString();
}

/**
 * Every encounter in one care story, oldest first.
 *
 * THIS is "the admission automatically inherits the OP consultation, its
 * investigations and its prescriptions" (ADR-0013 §4). The inheritance is a READ,
 * not a copy — which is why the admission can be a separate, separately-billable
 * encounter and the doctor still sees one unbroken history.
 */
export async function encountersInEpisode(episodeId: string): Promise<Encounter[]> {
  const docs = await getEncounterModel(getTenantDb())
    .find({ episodeId: new Types.ObjectId(episodeId), ...scopeFilter() })
    .sort({ arrivedAt: 1 })
    .lean<EncounterDoc[]>();

  return docs.map(toEncounter);
}
