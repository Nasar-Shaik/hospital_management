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
  getBedModel,
  type WardDoc,
  type BedDoc,
  type WardKind,
  type WardStatus,
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

/* ── Beds ──────────────────────────────────────────────────────────────────── */

export interface Bed {
  id: string;
  wardId: string;
  code: string;
  room?: string;
  /** The tariff the bed-day bills at — the bed's own, or its ward's when the bed sets none. */
  tariffCode: string;
  status: BedStatus;
  blockedReason?: string;
  branchId?: string;
  /** Denormalized from the ward for the list and the admit picker — never a stored field. */
  wardName: string;
  wardKind: WardKind;
  wardStatus: WardStatus;
}

/** Joins a bed to its ward so callers get the ward name + the EFFECTIVE tariff in one shape. */
function toBed(doc: BedDoc, ward: WardDoc): Bed {
  return {
    id: doc._id.toString(),
    wardId: doc.wardId.toString(),
    code: doc.code,
    ...(doc.room ? { room: doc.room } : {}),
    tariffCode: doc.tariffCode ?? ward.tariffCode,
    status: doc.status,
    ...(doc.blockedReason ? { blockedReason: doc.blockedReason } : {}),
    ...(doc.branchId ? { branchId: doc.branchId } : {}),
    wardName: ward.name,
    wardKind: ward.kind,
    wardStatus: ward.status,
  };
}

export interface CreateBedInput {
  wardId: string;
  code: string;
  room?: string;
  tariffCode?: string;
}

export async function createBed(input: CreateBedInput): Promise<Bed | undefined> {
  const ctx = getContext();
  const wardDoc = await getWardModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(input.wardId), ...scopeFilter() })
    .lean<WardDoc>();
  if (!wardDoc) return undefined;

  const branchId = await writeBranchId();
  const doc = await getBedModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    wardId: wardDoc._id,
    code: input.code,
    ...(input.room ? { room: input.room } : {}),
    ...(input.tariffCode ? { tariffCode: input.tariffCode } : {}),
    // A bed inherits its ward's branch: they are the same physical place.
    ...(wardDoc.branchId ? { branchId: wardDoc.branchId } : branchId ? { branchId } : {}),
  });
  return toBed(doc.toObject() as BedDoc, wardDoc);
}

/**
 * Every bed in the hospital (optionally one ward's), each carrying its ward's name + kind so the
 * board and the admit picker read without a second round trip. One query per collection, joined
 * in memory — a hospital has hundreds of beds, not millions.
 */
export async function listBeds(wardId?: string): Promise<Bed[]> {
  const db = getTenantDb();
  const bedFilter: Record<string, unknown> = { ...scopeFilter() };
  if (wardId && Types.ObjectId.isValid(wardId)) bedFilter.wardId = new Types.ObjectId(wardId);

  const [beds, wards] = await Promise.all([
    getBedModel(db).find(bedFilter).sort({ code: 1 }).lean<BedDoc[]>(),
    getWardModel(db)
      .find({ ...scopeFilter() })
      .lean<WardDoc[]>(),
  ]);
  const wardById = new Map(wards.map((w) => [w._id.toString(), w]));

  return beds
    .map((b) => {
      const ward = wardById.get(b.wardId.toString());
      return ward ? toBed(b, ward) : undefined;
    })
    .filter((b): b is Bed => b !== undefined);
}

/** One bed, resolved with its ward — the admit path reads this to validate and price a bed. */
export async function findBedById(id: string): Promise<Bed | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();
  const bed = await getBedModel(db)
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<BedDoc>();
  if (!bed) return undefined;
  const ward = await getWardModel(db)
    .findOne({ _id: bed.wardId, ...scopeFilter() })
    .lean<WardDoc>();
  return ward ? toBed(bed, ward) : undefined;
}

export interface UpdateBedInput {
  code?: string;
  room?: string;
  tariffCode?: string;
  status?: BedStatus;
  blockedReason?: string;
}

export async function updateBed(id: string, patch: UpdateBedInput): Promise<Bed | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const db = getTenantDb();

  // `blockedReason` only makes sense while blocked — clearing the block clears the reason, so a
  // bed put back in service never carries a stale "awaiting deep clean".
  const set: Record<string, unknown> = { ...patch };
  const unset: Record<string, unknown> = {};
  if (patch.status === "available") {
    delete set.blockedReason;
    unset.blockedReason = "";
  }

  const bed = await getBedModel(db)
    .findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...scopeFilter() },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true },
    )
    .lean<BedDoc>();
  if (!bed) return undefined;
  const ward = await getWardModel(db)
    .findOne({ _id: bed.wardId, ...scopeFilter() })
    .lean<WardDoc>();
  return ward ? toBed(bed, ward) : undefined;
}
