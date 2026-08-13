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
  /** A paid fast-track OP visit — sorts above normal patients in the doctor's queue. */
  express?: boolean;
  reason?: string;
  /** The doctor's OP visit summary — printed on the OPD slip. */
  diagnosis?: string;
  advice?: string;
  branchId?: string;
  arrivedAt: Date;
  /**
   * When the doctor called this patient in — the first move to `in_progress`.
   *
   * ── ARRIVING IS NOT BEING SEEN, AND A DOCUMENT MUST KNOW THE DIFFERENCE ─────
   * A visit gets its doctor at registration, before anyone has examined anybody, so `doctorId`
   * answers "who are they waiting for", never "who saw them". The OPD slip printed the doctor's
   * scanned SIGNATURE off `doctorId` alone: a patient who had paid the OP fee and was still in
   * the waiting room went home holding a sheet signed by a doctor who had not met them.
   *
   * `seenAt` is that missing fact, derived HERE from the encounter's own history so no client has
   * to re-derive it and drift. Absent means the consultation has not started. The state machine
   * makes that exact: `in_progress` is reachable only from `arrived`/`in_queue`, and `closed` and
   * `admitted` are reachable only THROUGH it (`TRANSITIONS`), so `seenAt` is present precisely
   * when a doctor has taken the patient in.
   */
  seenAt?: Date;
  closedAt?: Date;
  /** Present when `class` is `IP`. The bed is recorded, not reserved — see the model. */
  bed?: { ward: string; bedCode: string; tariffCode: string; bedId?: string };
  admittedAt?: Date;
  dischargedAt?: Date;
  disposition?: DischargeDisposition;
  admittedFrom?: string;
  /** Still-live orders on this visit — the guard on "send for investigations" reads it. */
  activeOrderCount: number;
  history: EncounterHistoryEntry[];
  createdAt: Date;
}

/**
 * The moment the consultation started, or `undefined` if it has not.
 *
 * An IP encounter opened straight at `in_progress` (admission — there is no queue for a bed) has
 * no transition to read, so it falls back to `arrivedAt`: the patient is unambiguously being
 * treated, and the alternative would be to report a live inpatient as "not yet seen".
 */
function seenAtOf(doc: EncounterDoc): Date | undefined {
  const called = (doc.history ?? []).find((h) => h.to === "in_progress");
  if (called) return called.at;
  return SEEN_STATUSES.has(doc.status) ? doc.arrivedAt : undefined;
}

/** The statuses only a started consultation can reach — see `TRANSITIONS` in the model. */
const SEEN_STATUSES = new Set<EncounterStatus>([
  "in_progress",
  "awaiting_results",
  "closed",
  "admitted",
]);

function toEncounter(doc: EncounterDoc): Encounter {
  const seenAt = seenAtOf(doc);
  return {
    id: doc._id.toString(),
    patientId: doc.patientId.toString(),
    episodeId: doc.episodeId.toString(),
    origin: doc.origin,
    class: doc.class,
    status: doc.status,
    arrivedAt: doc.arrivedAt,
    activeOrderCount: doc.activeOrderCount ?? 0,
    history: doc.history ?? [],
    createdAt: doc.createdAt,
    ...(doc.appointmentId ? { appointmentId: doc.appointmentId.toString() } : {}),
    ...(doc.doctorId ? { doctorId: doc.doctorId } : {}),
    ...(doc.departmentId ? { departmentId: doc.departmentId } : {}),
    ...(doc.token !== undefined ? { token: doc.token } : {}),
    ...(doc.express ? { express: true } : {}),
    ...(doc.reason ? { reason: doc.reason } : {}),
    ...(doc.diagnosis ? { diagnosis: doc.diagnosis } : {}),
    ...(doc.advice ? { advice: doc.advice } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    ...(seenAt ? { seenAt } : {}),
    ...(doc.closedAt ? { closedAt: doc.closedAt } : {}),
    ...(doc.bed
      ? {
          bed: {
            ward: doc.bed.ward,
            bedCode: doc.bed.bedCode,
            tariffCode: doc.bed.tariffCode,
            ...(doc.bed.bedId ? { bedId: doc.bed.bedId.toString() } : {}),
          },
        }
      : {}),
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
  express?: boolean;
  reason?: string;
  branchId?: string;
  bed?: { ward: string; bedCode: string; tariffCode: string; bedId?: string };
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
        ...(input.express ? { express: true } : {}),
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
 * Moves the recorded bed of an OPEN IP stay to another bed (B4 bed-to-bed transfer).
 *
 * Only the physical bed changes — never the status (a transfer is not a state change) and never the
 * `tariffCode` (the service keeps it; bed-days bill a stay at one rate). The filter pins `class: IP`
 * and `open: true` so a transfer can only touch a live admission, and the `one_open_stay_per_bed`
 * unique index does the occupancy check on commit: moving onto a taken bed is a duplicate key, which
 * the service turns into a 409. The field change is picked up by the audit plugin like any `$set`.
 */
export async function setBed(
  id: string,
  bed: { ward: string; bedCode: string; tariffCode: string; bedId?: string },
  session?: ClientSession,
): Promise<Encounter | undefined> {
  const doc = await getEncounterModel(getTenantDb())
    .findOneAndUpdate(
      { _id: id, class: "IP", open: true, ...scopeFilter() },
      { $set: { bed } },
      { new: true, ...(session ? { session } : {}) },
    )
    .lean<EncounterDoc>();
  return doc ? toEncounter(doc) : undefined;
}

/**
 * Adjusts the live order count by `delta` (`+1` when an order is placed, `−1` when one is cancelled).
 *
 * Called by the ORDERS module inside the order's OWN transaction, so the count moves in lockstep with
 * the order and a doctor who orders then immediately sends for investigations sees it already counted.
 * `$inc` is atomic; the count cannot go negative in practice because a place always precedes its
 * cancel and each runs exactly once (place dedupes on `requestId`, cancel is a one-way state move).
 */
export async function bumpOrderCount(
  id: string,
  delta: number,
  session?: ClientSession,
): Promise<void> {
  await getEncounterModel(getTenantDb()).updateOne(
    { _id: id },
    { $inc: { activeOrderCount: delta } },
    { ...(session ? { session } : {}) },
  );
}

/**
 * Records the doctor's OP visit summary (diagnosis / advice) for the OPD slip. A plain `$set` of
 * whichever fields were supplied — clearing a field is sending an empty string, which the service
 * translates to `$unset` so the slip does not print a stale line.
 */
export async function setVisitSummary(
  id: string,
  set: { diagnosis?: string; advice?: string },
  unset: { diagnosis?: 1; advice?: 1 },
): Promise<Encounter | undefined> {
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;
  const doc = await getEncounterModel(getTenantDb())
    .findOneAndUpdate({ _id: id }, update, { new: true })
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
 *
 * ── `_id` BREAKS THE TIE, AND PAGING IS WHY ─────────────────────────────────
 * Ward and bed code come close to identifying a row — `one_open_stay_per_bed_per_branch`
 * (migration 0020) is a unique partial index over `{tenantId, branchId, bed.ward, bed.bedCode}`
 * where `open` and `bed.bedCode` both exist, so two open stays cannot share a bed at one site.
 * Close, but not enough, in two real cases the index deliberately does not cover:
 *
 *   NO BED       — the partial filter requires `bed.bedCode` to exist, so any number of open IP
 *                  encounters may carry no bed at all. Every one of them sorts with both fields
 *                  missing, and they all compare equal.
 *   TWO BRANCHES — the index is per branch. In All-branches mode "General ward / A-12" at
 *                  Hyderabad and the same at Chennai are two rows with one sort key.
 *
 * MongoDB gives no stable order between equal keys, and it need not give the SAME order to the
 * `skip(0)` and `skip(40)` executions of one query — so a patient can land on both pages while
 * another lands on neither. Appending the unique `_id` makes the ordering TOTAL, which is what
 * makes `skip`-based paging correct rather than usually correct. It costs nothing: the tie-break
 * only decides rows that were already equal.
 */
/**
 * Everyone in a bed right now, optionally narrowed to one ward.
 *
 * ── WHY THE WARD FILTER IS A NAME, NOT AN ID (M3-S2) ────────────────────────
 * An admission records its bed as `{ ward, bedCode }` TEXT, not a reference to the bed catalogue
 * — see the occupancy index in migration 0046, which keys on the ward name for the same reason.
 * Filtering by a catalogue id would therefore match nothing on a hospital that admits with
 * free-text beds, which is the legacy path the field exists to support.
 *
 * Additive and optional: no `ward` behaves exactly as before. A nurse works one ward and the
 * worklist is unusable at a hospital with three hundred beds without this.
 */
export async function listInpatients(filter: {
  limit: number;
  skip: number;
  ward?: string;
}): Promise<{
  items: Encounter[];
  total: number;
}> {
  const model = getEncounterModel(getTenantDb());
  const query = {
    ...scopeFilter(),
    class: "IP",
    open: true,
    ...(filter.ward ? { "bed.ward": filter.ward } : {}),
  };

  const [docs, total] = await Promise.all([
    model
      .find(query)
      .sort({ "bed.ward": 1, "bed.bedCode": 1, _id: 1 })
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
      // The queue is called in TOKEN order — which is arrival order, which is the only order
      // a waiting room will accept as fair — EXCEPT that a paid express visit floats above the
      // normal patients (`express: -1` puts true first), each group still in token order. That
      // is exactly what the patient paid the express surcharge for.
      .find(query)
      .sort(filter.queuedOnly ? { express: -1, token: 1 } : { arrivedAt: -1 })
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

/**
 * A doctor's own encounters in a period — the raw material for their "my day" activity panel.
 *
 * Keyed on `doctorId`, not on the caller's row scope: this is "what did I, this doctor, do?", so it
 * is bounded by the doctor's own id rather than by `scopeFilter`. Cancelled and never-seen
 * encounters are excluded — a doctor did not "see" a patient who left the waiting room. Tenant
 * isolation still holds via the query hook.
 */
export async function encountersByDoctor(
  doctorId: string,
  from: Date,
  to: Date,
): Promise<Encounter[]> {
  const docs = await getEncounterModel(getTenantDb())
    .find({
      doctorId,
      arrivedAt: { $gte: from, $lt: to },
      status: { $nin: ["cancelled", "left_without_being_seen"] },
    })
    .sort({ arrivedAt: -1 })
    .lean<EncounterDoc[]>();
  return docs.map(toEncounter);
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
