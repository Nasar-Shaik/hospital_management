/**
 * Ward & bed repository — the ONLY code that queries `wards` and `beds` (Constitution §6).
 *
 * Reads are branch-aware through `scopeFilter()` like every other operational collection, so a
 * user confined to one site sees only that site's wards. Writes stamp the active `branchId`
 * (`writeBranchId`), so a bed created while working at Chennai belongs to Chennai.
 */
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getWardModel,
  getRoomModel,
  getBedModel,
  type WardDoc,
  type RoomDoc,
  type BedDoc,
  type WardKind,
  type WardStatus,
  type RoomKind,
  type RoomStatus,
  type BedStatus,
} from "./ward.model.js";

export { isDuplicateKey };

/* ── Wards ─────────────────────────────────────────────────────────────────── */

export interface Ward {
  id: string;
  name: string;
  kind: WardKind;
  tariffCode: string;
  status: WardStatus;
  branchId?: string;
}

function toWard(doc: WardDoc): Ward {
  return {
    id: doc._id.toString(),
    name: doc.name,
    kind: doc.kind,
    tariffCode: doc.tariffCode,
    status: doc.status,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
  };
}

export interface CreateWardInput {
  name: string;
  kind: WardKind;
  tariffCode: string;
}

export async function createWard(input: CreateWardInput): Promise<Ward> {
  const ctx = getContext();
  const branchId = await writeBranchId();
  const doc = await getWardModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    name: input.name,
    kind: input.kind,
    tariffCode: input.tariffCode,
    ...(branchId ? { branchId } : {}),
  });
  return toWard(doc.toObject() as WardDoc);
}

/** All wards, alphabetical — the admin list and the raw material for the board. */
export async function listWards(): Promise<Ward[]> {
  const docs = await getWardModel(getTenantDb())
    .find({ ...scopeFilter() })
    .sort({ name: 1 })
    .lean<WardDoc[]>();
  return docs.map(toWard);
}

export async function findWardById(id: string): Promise<Ward | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getWardModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<WardDoc>();
  return doc ? toWard(doc) : undefined;
}

export interface UpdateWardInput {
  name?: string;
  kind?: WardKind;
  tariffCode?: string;
  status?: WardStatus;
}

export async function updateWard(id: string, patch: UpdateWardInput): Promise<Ward | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getWardModel(getTenantDb())
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: patch },
      { new: true },
    )
    .lean<WardDoc>();
  return doc ? toWard(doc) : undefined;
}

/* ── Rooms ─────────────────────────────────────────────────────────────────── */

export interface Room {
  id: string;
  wardId: string;
  name: string;
  kind: RoomKind;
  /** The room-class tariff, when set — the middle link of the bed → room → ward price chain. */
  tariffCode?: string;
  status: RoomStatus;
  branchId?: string;
  /** Denormalized from the ward so the catalogue reads the room's ward name in one shape. */
  wardName: string;
}

function toRoom(doc: RoomDoc, ward: WardDoc): Room {
  return {
    id: doc._id.toString(),
    wardId: doc.wardId.toString(),
    name: doc.name,
    kind: doc.kind,
    ...(doc.tariffCode ? { tariffCode: doc.tariffCode } : {}),
    status: doc.status,
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    wardName: ward.name,
  };
}

export interface CreateRoomInput {
  wardId: string;
  name: string;
  kind: RoomKind;
  tariffCode?: string;
}

export async function createRoom(input: CreateRoomInput): Promise<Room | undefined> {
  const ctx = getContext();
  const wardDoc = await getWardModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(input.wardId), ...scopeFilter() })
    .lean<WardDoc>();
  if (!wardDoc) return undefined;

  const branchId = await writeBranchId();
  const doc = await getRoomModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    wardId: wardDoc._id,
    name: input.name,
    kind: input.kind,
    ...(input.tariffCode ? { tariffCode: input.tariffCode } : {}),
    // A room inherits its ward's branch: they are the same physical place.
    ...(wardDoc.branchId ? { branchId: wardDoc.branchId } : branchId ? { branchId } : {}),
  });
  return toRoom(doc.toObject() as RoomDoc, wardDoc);
}

/** Every room in the hospital (optionally one ward's), each carrying its ward name. */
export async function listRooms(wardId?: string): Promise<Room[]> {
  const db = getTenantDb();
  const filter: Record<string, unknown> = { ...scopeFilter() };
  if (wardId && Types.ObjectId.isValid(wardId)) filter.wardId = new Types.ObjectId(wardId);

  const [rooms, wards] = await Promise.all([
    getRoomModel(db).find(filter).sort({ name: 1 }).lean<RoomDoc[]>(),
    getWardModel(db)
      .find({ ...scopeFilter() })
      .lean<WardDoc[]>(),
  ]);
  const wardById = new Map(wards.map((w) => [w._id.toString(), w]));
  return rooms
    .map((r) => {
      const ward = wardById.get(r.wardId.toString());
      return ward ? toRoom(r, ward) : undefined;
    })
    .filter((r): r is Room => r !== undefined);
}

export async function findRoomById(id: string): Promise<Room | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const room = await getRoomModel(db)
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<RoomDoc>();
  if (!room) return undefined;
  const ward = await getWardModel(db)
    .findOne({ _id: room.wardId, ...scopeFilter() })
    .lean<WardDoc>();
  return ward ? toRoom(room, ward) : undefined;
}

export interface UpdateRoomInput {
  name?: string;
  kind?: RoomKind;
  tariffCode?: string;
  status?: RoomStatus;
}

export async function updateRoom(id: string, patch: UpdateRoomInput): Promise<Room | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();

  // A blank tariff clears the room-class override, dropping the bed back to the ward rate.
  const set: Record<string, unknown> = { ...patch };
  const unset: Record<string, unknown> = {};
  if (patch.tariffCode === "") {
    delete set.tariffCode;
    unset.tariffCode = "";
  }

  const room = await getRoomModel(db)
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true },
    )
    .lean<RoomDoc>();
  if (!room) return undefined;
  const ward = await getWardModel(db)
    .findOne({ _id: room.wardId, ...scopeFilter() })
    .lean<WardDoc>();
  return ward ? toRoom(room, ward) : undefined;
}

/* ── Beds ──────────────────────────────────────────────────────────────────── */

export interface Bed {
  id: string;
  wardId: string;
  roomId?: string;
  code: string;
  room?: string;
  /** The tariff the bed-day bills at — bed → room → ward, most specific wins. */
  tariffCode: string;
  status: BedStatus;
  blockedReason?: string;
  branchId?: string;
  /** Denormalized from the ward for the list and the admit picker — never a stored field. */
  wardName: string;
  wardKind: WardKind;
  wardStatus: WardStatus;
  /** Denormalized from the room, when the bed sits in one — the human-readable room name/class. */
  roomName?: string;
  roomKind?: RoomKind;
}

/**
 * Joins a bed to its ward (and its room, if it has one) so callers get the names + the EFFECTIVE
 * tariff in one shape. The price chain is bed → room → ward: the bed's own tariff wins, else the
 * room's, else the ward's.
 */
function toBed(doc: BedDoc, ward: WardDoc, room?: RoomDoc): Bed {
  return {
    id: doc._id.toString(),
    wardId: doc.wardId.toString(),
    ...(doc.roomId ? { roomId: doc.roomId.toString() } : {}),
    code: doc.code,
    ...(doc.room ? { room: doc.room } : {}),
    tariffCode: doc.tariffCode ?? room?.tariffCode ?? ward.tariffCode,
    status: doc.status,
    ...(doc.blockedReason ? { blockedReason: doc.blockedReason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    wardName: ward.name,
    wardKind: ward.kind,
    wardStatus: ward.status,
    ...(room ? { roomName: room.name, roomKind: room.kind } : {}),
  };
}

export interface CreateBedInput {
  wardId: string;
  roomId?: string;
  code: string;
  room?: string;
  tariffCode?: string;
}

export async function createBed(input: CreateBedInput): Promise<Bed | undefined> {
  const ctx = getContext();
  const db = getTenantDb();
  const wardDoc = await getWardModel(db)
    .findOne({ _id: new Types.ObjectId(input.wardId), ...scopeFilter() })
    .lean<WardDoc>();
  if (!wardDoc) return undefined;

  // A named room must exist AND belong to the same ward — a bed cannot sit in another ward's room.
  let roomDoc: RoomDoc | null = null;
  if (input.roomId) {
    roomDoc = await getRoomModel(db)
      .findOne({ _id: new Types.ObjectId(input.roomId), ...scopeFilter() })
      .lean<RoomDoc>();
    if (!roomDoc || roomDoc.wardId.toString() !== wardDoc._id.toString()) return undefined;
  }

  const branchId = await writeBranchId();
  const doc = await getBedModel(db).create({
    tenantId: ctx.tenantId,
    wardId: wardDoc._id,
    ...(roomDoc ? { roomId: roomDoc._id } : {}),
    code: input.code,
    ...(input.room ? { room: input.room } : {}),
    ...(input.tariffCode ? { tariffCode: input.tariffCode } : {}),
    // A bed inherits its ward's branch: they are the same physical place.
    ...(wardDoc.branchId ? { branchId: wardDoc.branchId } : branchId ? { branchId } : {}),
  });
  return toBed(doc.toObject() as BedDoc, wardDoc, roomDoc ?? undefined);
}

/**
 * Every bed in the hospital (optionally one ward's), each carrying its ward's name + kind (and its
 * room's, if it has one) so the board and the admit picker read without a second round trip. One
 * query per collection, joined in memory — a hospital has hundreds of beds, not millions.
 */
export async function listBeds(wardId?: string): Promise<Bed[]> {
  const db = getTenantDb();
  const bedFilter: Record<string, unknown> = { ...scopeFilter() };
  if (wardId && Types.ObjectId.isValid(wardId)) bedFilter.wardId = new Types.ObjectId(wardId);

  const [beds, wards, rooms] = await Promise.all([
    getBedModel(db).find(bedFilter).sort({ code: 1 }).lean<BedDoc[]>(),
    getWardModel(db)
      .find({ ...scopeFilter() })
      .lean<WardDoc[]>(),
    getRoomModel(db)
      .find({ ...scopeFilter() })
      .lean<RoomDoc[]>(),
  ]);
  const wardById = new Map(wards.map((w) => [w._id.toString(), w]));
  const roomById = new Map(rooms.map((r) => [r._id.toString(), r]));

  return beds
    .map((b) => {
      const ward = wardById.get(b.wardId.toString());
      const room = b.roomId ? roomById.get(b.roomId.toString()) : undefined;
      return ward ? toBed(b, ward, room) : undefined;
    })
    .filter((b): b is Bed => b !== undefined);
}

/**
 * How many beds this hospital has, across every site.
 *
 * Deliberately NOT `scopeFilter()`-ed, unlike its `listBeds` neighbour: a plan's bed allowance is
 * bought by the HOSPITAL, so counting only the site the viewer happens to have selected would
 * report a two-site hospital as using half of what it uses. The bed BOARD is per-site; the
 * inventory a plan is measured against is not.
 */
export async function countBeds(): Promise<number> {
  return getBedModel(getTenantDb()).countDocuments({});
}

/** One bed, resolved with its ward + room — the admit path reads this to validate and price a bed. */
export async function findBedById(id: string): Promise<Bed | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const bed = await getBedModel(db)
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<BedDoc>();
  if (!bed) return undefined;
  const [ward, room] = await Promise.all([
    getWardModel(db)
      .findOne({ _id: bed.wardId, ...scopeFilter() })
      .lean<WardDoc>(),
    bed.roomId
      ? getRoomModel(db)
          .findOne({ _id: bed.roomId, ...scopeFilter() })
          .lean<RoomDoc>()
      : Promise.resolve(null),
  ]);
  return ward ? toBed(bed, ward, room ?? undefined) : undefined;
}

export interface UpdateBedInput {
  roomId?: string | null;
  code?: string;
  room?: string;
  tariffCode?: string;
  status?: BedStatus;
  blockedReason?: string;
}

export async function updateBed(id: string, patch: UpdateBedInput): Promise<Bed | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();

  const existing = await getBedModel(db)
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<BedDoc>();
  if (!existing) return undefined;

  // `blockedReason` only makes sense while blocked — clearing the block clears the reason, so a
  // bed put back in service never carries a stale "awaiting deep clean".
  const set: Record<string, unknown> = { ...patch };
  const unset: Record<string, unknown> = {};
  if (patch.status === "available") {
    delete set.blockedReason;
    unset.blockedReason = "";
  }

  // `roomId` moves a bed between rooms, or (null / "") pulls it out onto the open ward floor. A
  // named room must exist and share the bed's ward — a bed cannot cross into another ward's room.
  if (patch.roomId !== undefined) {
    delete set.roomId;
    if (patch.roomId === null || patch.roomId === "") {
      unset.roomId = "";
    } else {
      const room = await getRoomModel(db)
        .findOne({ _id: new Types.ObjectId(patch.roomId), ...scopeFilter() })
        .lean<RoomDoc>();
      if (!room || room.wardId.toString() !== existing.wardId.toString()) return undefined;
      set.roomId = room._id;
    }
  }

  const bed = await getBedModel(db)
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true },
    )
    .lean<BedDoc>();
  if (!bed) return undefined;
  const [ward, room] = await Promise.all([
    getWardModel(db)
      .findOne({ _id: bed.wardId, ...scopeFilter() })
      .lean<WardDoc>(),
    bed.roomId
      ? getRoomModel(db)
          .findOne({ _id: bed.roomId, ...scopeFilter() })
          .lean<RoomDoc>()
      : Promise.resolve(null),
  ]);
  return ward ? toBed(bed, ward, room ?? undefined) : undefined;
}
