/**
 * Theatre & OT-booking repository — the ONLY code that queries `theatres` / `otBookings`
 * (Constitution §6).
 *
 * Branch-aware, like the bed inventory: reads pass through `scopeFilter()` (a user confined to one
 * site sees only its theatres and its list) and writes stamp the active `branchId`
 * (`writeBranchId`). Occupancy of a theatre WINDOW is not stored — it is the set of occupying
 * bookings, which is what `findOverlap` reads.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getTheatreModel,
  getOtBookingModel,
  occupiesTheatre,
  type TheatreDoc,
  type OtBookingDoc,
  type TheatreKind,
  type TheatreStatus,
  RECORDABLE_STATUSES,
  type OtBookingStatus,
  type OtStatusChange,
  type OperativeNote,
} from "./theatre.model.js";

export { isDuplicateKey };

/* ── Theatres ───────────────────────────────────────────────────────────────── */

export interface Theatre {
  id: string;
  name: string;
  code: string;
  kind: TheatreKind;
  status: TheatreStatus;
  branchId?: string;
}

function toTheatre(doc: TheatreDoc): Theatre {
  return {
    id: doc._id.toString(),
    name: doc.name,
    code: doc.code,
    kind: doc.kind,
    status: doc.status,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateTheatreInput {
  name: string;
  code: string;
  kind: TheatreKind;
}

export async function createTheatre(input: CreateTheatreInput): Promise<Theatre> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getTheatreModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    code: input.code.toUpperCase(),
    kind: input.kind,
    ...(branchId ? { branchId } : {}),
  });
  return toTheatre(doc.toObject() as TheatreDoc);
}

export async function listTheatres(): Promise<Theatre[]> {
  const docs = await getTheatreModel(getTenantDb())
    .find({ ...scopeFilter() })
    .sort({ code: 1 })
    .lean<TheatreDoc[]>();
  return docs.map(toTheatre);
}

export async function findTheatreById(id: string): Promise<Theatre | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getTheatreModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<TheatreDoc>();
  return doc ? toTheatre(doc) : undefined;
}

export interface UpdateTheatreInput {
  name?: string;
  kind?: TheatreKind;
  status?: TheatreStatus;
}

export async function updateTheatre(
  id: string,
  patch: UpdateTheatreInput,
): Promise<Theatre | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getTheatreModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<TheatreDoc>();
  return doc ? toTheatre(doc) : undefined;
}

/* ── OT bookings ────────────────────────────────────────────────────────────── */

export interface OtBooking {
  id: string;
  theatreId: string;
  theatreName: string;
  theatreCode: string;
  patientId: string;
  surgeonId: string;
  encounterId?: string;
  procedureName: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: OtBookingStatus;
  notes?: string;
  operativeNote?: OperativeNoteView;
  branchId?: string;
}

/** The operative record as it leaves the API — dates as ISO strings, like every other contract. */
export interface OperativeNoteView {
  procedurePerformed: string;
  surgeonId: string;
  performedAt: string;
  findings?: string;
  notes?: string;
  recordedBy?: string;
  recordedAt: string;
}

function toNote(note: OperativeNote): OperativeNoteView {
  return {
    procedurePerformed: note.procedurePerformed,
    surgeonId: note.surgeonId,
    performedAt: note.performedAt.toISOString(),
    ...(note.findings ? { findings: note.findings } : {}),
    ...(note.notes ? { notes: note.notes } : {}),
    ...(note.recordedBy ? { recordedBy: note.recordedBy } : {}),
    recordedAt: note.recordedAt.toISOString(),
  };
}

function toBooking(doc: OtBookingDoc, theatre?: TheatreDoc): OtBooking {
  return {
    id: doc._id.toString(),
    theatreId: doc.theatreId.toString(),
    theatreName: theatre?.name ?? "—",
    theatreCode: theatre?.code ?? "—",
    patientId: doc.patientId,
    surgeonId: doc.surgeonId,
    ...(doc.encounterId ? { encounterId: doc.encounterId.toString() } : {}),
    procedureName: doc.procedureName,
    scheduledStart: doc.scheduledStart.toISOString(),
    scheduledEnd: doc.scheduledEnd.toISOString(),
    status: doc.status,
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.operativeNote ? { operativeNote: toNote(doc.operativeNote) } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateBookingInput {
  theatreId: string;
  patientId: string;
  surgeonId: string;
  encounterId?: string;
  procedureName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  notes?: string;
  bookedBy?: string;
}

export async function createBooking(
  input: CreateBookingInput,
  theatre: TheatreDoc,
): Promise<OtBooking> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getOtBookingModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    theatreId: theatre._id,
    patientId: input.patientId,
    surgeonId: input.surgeonId,
    ...(input.encounterId ? { encounterId: new Types.ObjectId(input.encounterId) } : {}),
    procedureName: input.procedureName,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    ...(input.notes ? { notes: input.notes } : {}),
    status: "scheduled",
    occupies: true, // a fresh booking holds its window (occupiesTheatre("scheduled") === true)
    ...(input.bookedBy ? { bookedBy: input.bookedBy } : {}),
    // A booking inherits its theatre's branch: they are the same physical place.
    ...(theatre.branchId ? { branchId: theatre.branchId } : branchId ? { branchId } : {}),
  });
  return toBooking(doc.toObject() as OtBookingDoc, theatre);
}

/** The raw booking doc — the transition path reads this to check the state machine. */
export async function findBookingDocById(id: string): Promise<OtBookingDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getOtBookingModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<OtBookingDoc>();
  return doc ?? undefined;
}

export async function getTheatreDoc(id: string): Promise<TheatreDoc | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getTheatreModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<TheatreDoc>();
  return doc ?? undefined;
}

/**
 * The first OCCUPYING booking on this theatre whose window overlaps [start, end), excluding
 * `exceptId` (the booking being edited). This IS the collision rule — two windows overlap when each
 * starts before the other ends. Returns the conflict so the caller can name it in the error.
 */
export async function findOverlap(
  theatreId: string,
  start: Date,
  end: Date,
  exceptId?: string,
): Promise<OtBooking | undefined> {
  if (!Types.ObjectId.isValid(theatreId)) return undefined;
  const db = getTenantDb();
  const clash = await getOtBookingModel(db)
    .findOne({
      ...scopeFilter(),
      theatreId: new Types.ObjectId(theatreId),
      occupies: true,
      scheduledStart: { $lt: end },
      scheduledEnd: { $gt: start },
      ...(exceptId && Types.ObjectId.isValid(exceptId)
        ? { _id: { $ne: new Types.ObjectId(exceptId) } }
        : {}),
    })
    .lean<OtBookingDoc>();
  if (!clash) return undefined;
  const theatre = await getTheatreModel(db).findById(clash.theatreId).lean<TheatreDoc>();
  return toBooking(clash, theatre ?? undefined);
}

/**
 * The OT board: bookings whose window intersects [from, to), scoped, oldest first, each joined to
 * its theatre. One query per collection, joined in memory — a theatre list runs a day, not millions.
 */
export async function listBookings(filter: {
  from?: Date;
  to?: Date;
  patientId?: string;
  theatreId?: string;
  status?: OtBookingStatus;
}): Promise<OtBooking[]> {
  const db = getTenantDb();
  const q: Record<string, unknown> = { ...scopeFilter() };
  /**
   * The window is OPTIONAL, and its absence is what makes this the same query the chart needs.
   * A board asks "what is happening today"; a chart asks "what has this patient ever had done" —
   * one collection, one scoped read, two questions. The controller supplies today's window when
   * nobody names a patient, so the board's behaviour is unchanged.
   */
  if (filter.to) q.scheduledStart = { $lt: filter.to };
  if (filter.from) q.scheduledEnd = { $gt: filter.from };
  if (filter.patientId) q.patientId = filter.patientId;
  if (filter.theatreId && Types.ObjectId.isValid(filter.theatreId)) {
    q.theatreId = new Types.ObjectId(filter.theatreId);
  }
  if (filter.status) q.status = filter.status;

  const [bookings, theatres] = await Promise.all([
    getOtBookingModel(db).find(q).sort({ scheduledStart: 1 }).lean<OtBookingDoc[]>(),
    getTheatreModel(db)
      .find({ ...scopeFilter() })
      .lean<TheatreDoc[]>(),
  ]);
  const byId = new Map(theatres.map((t) => [t._id.toString(), t]));
  return bookings.map((b) => toBooking(b, byId.get(b.theatreId.toString())));
}

/**
 * Applies a state transition: writes the new status, appends the history line, and MAINTAINS
 * `occupies` in the one place it is ever set — present while the booking holds its window, unset the
 * instant it releases it (so a cancelled booking frees the theatre for the overlap check). Mirrors
 * the appointment module's `setStatus`.
 */
export async function setStatus(
  id: string,
  to: OtBookingStatus,
  change: OtStatusChange,
): Promise<OtBooking | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const set: Record<string, unknown> = { status: to };
  const unset: Record<string, unknown> = {};
  if (occupiesTheatre(to)) set.occupies = true;
  else unset.occupies = "";

  const doc = await getOtBookingModel(db)
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $push: { statusHistory: change },
      },
      { new: true },
    )
    .lean<OtBookingDoc>();
  if (!doc) return undefined;
  const theatre = await getTheatreModel(db).findById(doc.theatreId).lean<TheatreDoc>();
  return toBooking(doc, theatre ?? undefined);
}

/**
 * Writes the operative note — the ONLY path that ever sets it.
 *
 * ── THE GUARD IS THE QUERY ──────────────────────────────────────────────────
 * Both rules live in the filter, not in an `if` above it:
 *   `status: { $in: RECORDABLE }`   — a note cannot describe an operation that has not started or
 *                                     was cancelled;
 *   `operativeNote: { $exists: false }` — it is written exactly once.
 * Read-then-write would leave a window in which two devices both see "no note yet" and the second
 * silently overwrites a signed clinical record. A conditional update has no such window: the
 * loser's filter matches nothing and it gets `undefined`, which the service turns into a 409. The
 * caller distinguishes "wrong state" from "already written" by re-reading, not by guessing.
 */
export async function recordOperativeNote(
  id: string,
  note: OperativeNote,
): Promise<OtBooking | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const doc = await getOtBookingModel(db)
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        ...scopeFilter(),
        status: { $in: RECORDABLE_STATUSES },
        operativeNote: { $exists: false },
      },
      { $set: { operativeNote: note } },
      { new: true },
    )
    .lean<OtBookingDoc>();
  if (!doc) return undefined;
  const theatre = await getTheatreModel(db).findById(doc.theatreId).lean<TheatreDoc>();
  return toBooking(doc, theatre ?? undefined);
}
