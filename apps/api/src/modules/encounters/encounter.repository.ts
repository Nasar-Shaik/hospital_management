/**
 * Encounter repository — the ONLY code that queries `encounters` and
 * `episodesOfCare` (Constitution §6).
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import { scopeFilter } from "../../middleware/authorize.js";
import {
  getEncounterModel,
  getEpisodeModel,
  isOpen,
  type DischargeDisposition,
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
  /** Present when `class` is `IP`. The bed is recorded, not reserved — see the model. */
  bed?: { ward: string; bedCode: string; tariffCode: string };
  admittedAt?: Date;
  dischargedAt?: Date;
  disposition?: DischargeDisposition;
  admittedFrom?: string;
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
    ...(doc.bed ? { bed: doc.bed } : {}),
    ...(doc.admittedAt ? { admittedAt: doc.admittedAt } : {}),
    ...(doc.dischargedAt ? { dischargedAt: doc.dischargedAt } : {}),
    ...(doc.disposition ? { disposition: doc.disposition } : {}),
    ...(doc.admittedFrom ? { admittedFrom: doc.admittedFrom.toString() } : {}),
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
  bed?: { ward: string; bedCode: string; tariffCode: string };
  admittedAt?: Date;
  admittedFrom?: string;
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
        ...(input.bed ? { bed: input.bed } : {}),
        ...(input.admittedAt ? { admittedAt: input.admittedAt } : {}),
        ...(input.admittedFrom ? { admittedFrom: new Types.ObjectId(input.admittedFrom) } : {}),
        ...(ctx.userId ? { createdBy: ctx.userId } : {}),
      },
    ],
    { session },
  );

  if (!doc) throw new Error("encounter insert returned nothing");
  return toEncounter(doc);
}

/**
 * Moves the patient to another doctor, and records the handover in the history.
 *
 * Deliberately NOT a generic `update(id, fields)`. A repository method that can set any
 * field is a repository method that will eventually be used to set `status` behind the
 * state machine's back — and the whole point of `setStatus` is that there is exactly one
 * door. This one changes `doctorId`, appends the handover, and can do nothing else.
 */
export async function setDoctor(
  id: string,
  doctorId: string,
  entry: EncounterHistoryEntry,
  session?: ClientSession,
): Promise<Encounter | undefined> {
  const doc = await getEncounterModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id },
      { $set: { doctorId }, $push: { history: entry } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<EncounterDoc>();

  return doc ? toEncounter(doc) : undefined;
}

/**
 * Everyone currently in a bed — the ward round's list.
 *
 * `class: IP` + `open: true`. Not a "wards" query, because there are no wards: without a
 * bed inventory this is the closest thing the hospital has to an occupancy list, and it is
 * derived from where the patients actually are rather than from a map somebody maintains.
 * Sorted by ward then bed, which is the order a doctor physically walks.
 */
export async function listInpatients(filter: { limit: number; skip: number }): Promise<{
  items: Encounter[];
  total: number;
}> {
  const model = getEncounterModel(getTenantDb());
  const query = { ...scopeFilter(), class: "IP", open: true };

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ "bed.ward": 1, "bed.bedCode": 1 })
      .skip(filter.skip)
      .limit(filter.limit)
      .lean<EncounterDoc[]>(),
    model.countDocuments(query),
  ]);

  return { items: docs.map(toEncounter), total };
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
  /** Arrived on or after. Half-open with `arrivedBefore` — see the service. */
  arrivedFrom?: Date;
  arrivedBefore?: Date;
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
    /**
     * HALF-OPEN: `>= start` and `< next midnight`. Never `<= end of day`, because the
     * "end" of a day is 23:59:59.999 and a patient who arrives in that last
     * millisecond vanishes from the register — a bug that is invisible for years and
     * then loses exactly one record.
     */
    ...(filter.arrivedFrom || filter.arrivedBefore
      ? {
          arrivedAt: {
            ...(filter.arrivedFrom ? { $gte: filter.arrivedFrom } : {}),
            ...(filter.arrivedBefore ? { $lt: filter.arrivedBefore } : {}),
          },
        }
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

/* ── Reporting aggregations (period on `arrivedAt`, half-open [from, to)) ────── */

export interface VisitReport {
  total: number;
  byClass: { key: string; count: number }[];
  byOrigin: { key: string; count: number }[];
  byMonth: { month: string; count: number }[];
}

/**
 * How many patients presented in a period, and how they break down.
 *
 * Counts every encounter that ARRIVED in the window — the visit register a hospital reports to
 * itself and to an auditor. Cancelled and left-without-being-seen are excluded: they are not
 * visits, they are visits that did not happen. Grouped three ways from one scan so the totals
 * across the breakdowns always agree with the headline. Tenant-scoped by the aggregate hook.
 */
export async function visitReport(from: Date, to: Date): Promise<VisitReport> {
  const model = getEncounterModel(getTenantDb());
  const match = {
    arrivedAt: { $gte: from, $lt: to },
    status: { $nin: ["cancelled", "left_without_being_seen"] },
  };
  const facet = await model.aggregate<{
    total: { count: number }[];
    byClass: { _id: string; count: number }[];
    byOrigin: { _id: string; count: number }[];
    byMonth: { _id: string; count: number }[];
  }>([
    { $match: match },
    {
      $facet: {
        total: [{ $count: "count" }],
        byClass: [{ $group: { _id: "$class", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byOrigin: [{ $group: { _id: "$origin", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byMonth: [
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$arrivedAt" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);
  const f = facet[0];
  return {
    total: f?.total[0]?.count ?? 0,
    byClass: (f?.byClass ?? []).map((r) => ({ key: r._id, count: r.count })),
    byOrigin: (f?.byOrigin ?? []).map((r) => ({ key: r._id, count: r.count })),
    byMonth: (f?.byMonth ?? []).map((r) => ({ month: r._id, count: r.count })),
  };
}

export interface DoctorLoadRow {
  doctorId: string;
  patients: number;
}

/**
 * Which doctor saw how many patients in the period, busiest first.
 *
 * Keyed on `doctorId` for encounters that arrived in the window and were assigned a doctor —
 * the name is resolved by the caller (the reporting module), because a doctor's name lives in
 * the users module, not here. An unassigned encounter (walk-in not yet routed) carries no
 * doctor and is simply not counted against anyone.
 */
export async function doctorProductivity(from: Date, to: Date): Promise<DoctorLoadRow[]> {
  const rows = await getEncounterModel(getTenantDb()).aggregate<{ _id: string; patients: number }>([
    {
      $match: {
        arrivedAt: { $gte: from, $lt: to },
        doctorId: { $exists: true, $ne: null },
        status: { $nin: ["cancelled", "left_without_being_seen"] },
      },
    },
    { $group: { _id: "$doctorId", patients: { $sum: 1 } } },
    { $sort: { patients: -1 } },
  ]);
  return rows.map((r) => ({ doctorId: r._id, patients: r.patients }));
}

export interface DischargeRegister {
  /** Inpatient stays that ENDED in the window, however they ended. */
  total: number;
  /** discharged / lama / absconded / deceased, commonest first. */
  byDisposition: { key: string; count: number }[];
  /** Stays that ended each month — the census an auditor reconciles against. */
  byMonth: { month: string; count: number }[];
}

/**
 * How inpatient stays ENDED in a period — the discharge / mortality register.
 *
 * One scan over the IP encounters that CLOSED within [from, to), grouped by disposition, so a
 * medical director or an auditor reads the death count, the LAMA count and the routine discharges
 * off the same figure the census is built from. A stay that closed BEFORE the disposition field
 * existed is counted as `discharged` — which is exactly what those closes meant at the time, so the
 * register stays truthful across the change rather than showing a block of "unknown". Tenant-scoped
 * by the aggregate hook.
 */
export async function dischargeRegister(from: Date, to: Date): Promise<DischargeRegister> {
  const model = getEncounterModel(getTenantDb());
  const facet = await model.aggregate<{
    total: { count: number }[];
    byDisposition: { _id: string; count: number }[];
    byMonth: { _id: string; count: number }[];
  }>([
    { $match: { class: "IP", status: "closed", dischargedAt: { $gte: from, $lt: to } } },
    { $set: { disp: { $ifNull: ["$disposition", "discharged"] } } },
    {
      $facet: {
        total: [{ $count: "count" }],
        byDisposition: [{ $group: { _id: "$disp", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byMonth: [
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$dischargedAt" } },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);
  const f = facet[0];
  return {
    total: f?.total[0]?.count ?? 0,
    byDisposition: (f?.byDisposition ?? []).map((r) => ({ key: r._id, count: r.count })),
    byMonth: (f?.byMonth ?? []).map((r) => ({ month: r._id, count: r.count })),
  };
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

/**
 * Move a merged patient's encounters AND episodes of care onto the survivor
 * (patient.patients.merged). Both collections key on patientId; a re-point that moved
 * one but not the other would leave an encounter in an episode belonging to someone
 * else. Returns the total rows moved across both. Idempotent — see repointPatientId.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  const conn = getTenantDb();
  const encounters = await repointPatientId(getEncounterModel(conn), "patientId", ref, {
    objectId: true,
  });
  const episodes = await repointPatientId(getEpisodeModel(conn), "patientId", ref, {
    objectId: true,
  });
  return encounters + episodes;
}
