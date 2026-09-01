/**
 * Store repository — the ONLY code that queries `inventoryItems`, `inventoryStock` and
 * `inventoryMovements` (Constitution §6).
 *
 * ── THE TWO INVARIANTS THIS FILE EXISTS TO KEEP ─────────────────────────────
 * 1. A movement and the balance it produces are written TOGETHER (the service wraps `add`/`take`
 *    in a transaction), so the shelf can never disagree with the ledger that explains it. The balance
 *    is produced by an atomic `$inc` and read back, then stamped onto the movement — so two
 *    concurrent receipts cannot both read 40, add 10, and both write 50.
 *
 * 2. THE SHELF NEVER GOES NEGATIVE, and that is arbitrated by the database rather than by a
 *    read-then-check-then-write. Taking stock out is a conditional update requiring
 *    `onHand >= quantity`; when it matches nothing, the caller is told there was not enough. Two
 *    store keepers issuing the last thirty gloves at the same instant therefore cannot both
 *    succeed — one wins, the other is refused, and neither had to hold a lock. Same discipline as
 *    `takeFromBatch` and the bed-occupancy index: correctness by database.
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { scopeFilter } from "../../middleware/authorize.js";
import { isDuplicateKey } from "../../core/db/mongoErrors.js";
import {
  getInventoryItemModel,
  getInventoryMovementModel,
  getInventoryStockModel,
  type InventoryItemDoc,
  type InventoryMovementDoc,
  type InventoryStockDoc,
  type ItemCategory,
  type ItemUnit,
  type MovementKind,
} from "./inventory.model.js";

export { isDuplicateKey };

/* ── what leaves the module ────────────────────────────────────────────────── */

export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  reorderLevel: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryMovement {
  id: string;
  itemId: string;
  itemCode: string;
  kind: MovementKind;
  delta: number;
  balanceAfter: number;
  supplierId?: string;
  supplierName?: string;
  invoiceRef?: string;
  unitCost?: number;
  departmentId?: string;
  departmentName?: string;
  reason?: string;
  branchId?: string;
  createdBy: string;
  createdAt: Date;
}

function toItem(d: InventoryItemDoc): InventoryItem {
  return {
    id: d._id.toString(),
    code: d.code,
    name: d.name,
    category: d.category,
    unit: d.unit,
    reorderLevel: d.reorderLevel,
    active: d.active,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toMovement(d: InventoryMovementDoc): InventoryMovement {
  return {
    id: d._id.toString(),
    itemId: d.itemId.toString(),
    itemCode: d.itemCode,
    kind: d.kind,
    delta: d.delta,
    balanceAfter: d.balanceAfter,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    ...(d.supplierId ? { supplierId: d.supplierId.toString() } : {}),
    ...(d.supplierName ? { supplierName: d.supplierName } : {}),
    ...(d.invoiceRef ? { invoiceRef: d.invoiceRef } : {}),
    ...(d.unitCost !== undefined ? { unitCost: d.unitCost } : {}),
    ...(d.departmentId ? { departmentId: d.departmentId.toString() } : {}),
    ...(d.departmentName ? { departmentName: d.departmentName } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.branchId ? { branchId: d.branchId } : {}),
  };
}

/* ── 1. the master ─────────────────────────────────────────────────────────── */

export interface CreateItemInput {
  code: string;
  name: string;
  category: ItemCategory;
  unit: ItemUnit;
  reorderLevel?: number;
}

/**
 * Adds an item to the master. Starts with NO shelf row anywhere — nothing is in the store until a
 * receipt says so, exactly as a medicine starts at zero. The unique index (migration 0054) turns a
 * repeated code into a duplicate-key error the service reads as "that code is taken".
 */
export async function createItem(input: CreateItemInput): Promise<InventoryItem> {
  const ctx = getContext();
  const doc = await getInventoryItemModel(getTenantDb()).create({
    tenantId: ctx.tenantId,
    code: input.code,
    name: input.name,
    category: input.category,
    unit: input.unit,
    reorderLevel: input.reorderLevel ?? 0,
    active: true,
  });
  return toItem(doc.toObject() as InventoryItemDoc);
}

/** The descriptive fields a store keeper may edit. NOT the balance — that moves via the ledger. */
export type UpdateItemInput = Partial<Omit<CreateItemInput, "code">> & { active?: boolean };

export async function updateItem(
  id: string,
  patch: UpdateItemInput,
): Promise<InventoryItem | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getInventoryItemModel(getTenantDb())
    .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true })
    .lean<InventoryItemDoc>();
  return doc ? toItem(doc) : undefined;
}

export interface ListItemsFilter {
  search?: string;
  includeInactive?: boolean;
}

/**
 * The item master — TENANT-WIDE, like the medicine master and the tariff.
 *
 * What the hospital stocks is one list; what is on a given site's shelf is `stockByItem` below.
 * Scoping the catalogue to a branch would hide an item from the site that has run out of it,
 * which is precisely the site that needs to see it.
 */
export async function listItems(filter: ListItemsFilter = {}): Promise<InventoryItem[]> {
  const query: Record<string, unknown> = {};
  if (!filter.includeInactive) query.active = true;
  if (filter.search) {
    const rx = new RegExp(escapeRegExp(filter.search), "i");
    query.$or = [{ code: rx }, { name: rx }];
  }
  const docs = await getInventoryItemModel(getTenantDb())
    .find(query)
    .sort({ name: 1 })
    .lean<InventoryItemDoc[]>();
  return docs.map(toItem);
}

/**
 * One item. Deliberately UNSCOPED, and declared in `scopedReads.test.ts` — see `listItems`.
 */
export async function findItemById(id: string): Promise<InventoryItem | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getInventoryItemModel(getTenantDb())
    .findById(new Types.ObjectId(id))
    .lean<InventoryItemDoc>();
  return doc ? toItem(doc) : undefined;
}

/* ── 2. the shelf ──────────────────────────────────────────────────────────── */

/**
 * The key of ONE site's shelf for one item.
 *
 * The `$exists: false` arm is not decoration. A tenant provisioned before branches existed writes
 * branchless (`writeBranchId()` returns `undefined` for it), and Mongoose DROPS an `undefined`
 * value from a query — so `{ itemId, branchId: undefined }` would silently become `{ itemId }`
 * and match ANY site's shelf. That is a cross-branch write dressed as a missing field, and it
 * would only ever appear on the one kind of tenant nobody tests with.
 *
 * `$exists: false` is also the right thing on an upsert: Mongo copies EQUALITY conditions from the
 * filter into the inserted document and leaves the others alone, so the new row correctly gets no
 * `branchId` rather than one set to null.
 */
function shelfKey(itemId: Types.ObjectId, branchId?: string): Record<string, unknown> {
  return branchId === undefined ? { itemId, branchId: { $exists: false } } : { itemId, branchId };
}

/**
 * On-hand per item at the shelves the caller may see, summed.
 *
 * ── ONE QUERY FOR THE WHOLE PAGE ────────────────────────────────────────────
 * A `$in` over the page's item ids, never one lookup per row. This is the same rule D18 was
 * raised for: a list that resolves each row separately is a list that gets slower and eventually
 * silently wrong.
 *
 * ── AND IT SUMS, WHICH IS THE HONEST ANSWER UNDER "ALL BRANCHES" ────────────
 * `scopeFilter()` returns one branch when a site is selected, and the caller's whole allowed set
 * when none is. With a site selected the sum is that site's shelf; in the aggregate view it is
 * "everything you can see", which is what the aggregate view means everywhere else in this
 * product. It is NOT a hospital-wide figure for a user confined to one site, because their filter
 * cannot reach the other.
 */
export async function stockByItem(itemIds: string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const ids = itemIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return new Map();

  const rows = await getInventoryStockModel(getTenantDb())
    .find({ itemId: { $in: ids }, ...scopeFilter() })
    .lean<InventoryStockDoc[]>();

  const out = new Map<string, number>();
  for (const row of rows) {
    const key = row.itemId.toString();
    out.set(key, (out.get(key) ?? 0) + row.onHand);
  }
  return out;
}

/* ── 3. moving stock ───────────────────────────────────────────────────────── */

export interface MoveInput {
  kind: MovementKind;
  /** Signed: positive in, negative out. */
  delta: number;
  branchId?: string;
  supplierId?: string;
  supplierName?: string;
  invoiceRef?: string;
  unitCost?: number;
  departmentId?: string;
  departmentName?: string;
  reason?: string;
}

/** What a movement produced: the shelf after it, and the ledger row that explains it. */
export interface Moved {
  onHand: number;
  movement: InventoryMovement;
}

/** Taking stock out can be refused. `insufficient` is an ANSWER, not a failure — see `take`. */
export type TakeResult = Moved | { insufficient: true; onHand: number };

export function wasTaken(result: TakeResult): result is Moved {
  return !("insufficient" in result);
}

/**
 * Adds stock to ONE site's shelf and records why.
 *
 * ── WHY THIS IS A SEPARATE FUNCTION FROM `take` ─────────────────────────────
 * They were one `move(delta)` taking a signed number, and the receipt path then had to handle a
 * "not enough" answer that adding stock can never produce — an unreachable `HMS-GEN-500` whose
 * only purpose was to narrow a union. `errorContract.test.ts` caught it: a 5xx `AppError` writes
 * its `details` to the server log verbatim, so every one of them has to be reviewed, and one that
 * cannot happen is a review nobody can do.
 *
 * Splitting the two makes the difference a TYPE rather than a runtime branch: adding always
 * succeeds and says so, taking may be refused and says that. The shared work lives in `record`.
 */
export async function add(
  item: InventoryItem,
  input: MoveInput,
  session: ClientSession,
): Promise<Moved> {
  const itemId = new Types.ObjectId(item.id);
  const updated = await getInventoryStockModel(getTenantDb())
    .findOneAndUpdate(
      shelfKey(itemId, input.branchId),
      {
        $inc: { onHand: input.delta },
        $setOnInsert: {
          itemCode: item.code,
          ...(input.branchId ? { branchId: input.branchId } : {}),
        },
      },
      { new: true, upsert: true, session },
    )
    .lean<InventoryStockDoc>();

  const onHand = updated?.onHand ?? input.delta;
  return { onHand, movement: await record(item, input, onHand, session) };
}

/**
 * Takes stock off ONE site's shelf and records why — or reports that it could not.
 *
 * The conditional update is the arbitration: it matches only when the shelf can cover the
 * quantity, so running out is discovered by the database in the same operation that would have
 * taken the stock, and never by a read the next writer invalidates. The current balance comes back
 * with the refusal, because "not enough" is only useful alongside "you have 12".
 */
export async function take(
  item: InventoryItem,
  input: MoveInput,
  session: ClientSession,
): Promise<TakeResult> {
  const db = getTenantDb();
  const itemId = new Types.ObjectId(item.id);
  const key = shelfKey(itemId, input.branchId);

  const updated = await getInventoryStockModel(db)
    .findOneAndUpdate(
      { ...key, onHand: { $gte: -input.delta } },
      { $inc: { onHand: input.delta } },
      { new: true, session },
    )
    .lean<InventoryStockDoc>();

  if (!updated) {
    // Nothing matched: either no shelf row at this site, or not enough on it. Both mean the same
    // thing to the caller, and the number they need to hear is what IS there.
    const current = await getInventoryStockModel(db)
      .findOne(key, undefined, { session })
      .lean<InventoryStockDoc>();
    return { insufficient: true, onHand: current?.onHand ?? 0 };
  }

  return { onHand: updated.onHand, movement: await record(item, input, updated.onHand, session) };
}

/** The ledger row, written in the same transaction as the balance it explains. */
async function record(
  item: InventoryItem,
  input: MoveInput,
  balanceAfter: number,
  session: ClientSession,
): Promise<InventoryMovement> {
  const ctx = getContext();
  const [row] = await getInventoryMovementModel(getTenantDb()).create(
    [
      {
        tenantId: ctx.tenantId,
        itemId: new Types.ObjectId(item.id),
        itemCode: item.code,
        kind: input.kind,
        delta: input.delta,
        balanceAfter,
        createdBy: ctx.userId ?? "system",
        createdAt: new Date(),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        ...(input.supplierId ? { supplierId: new Types.ObjectId(input.supplierId) } : {}),
        ...(input.supplierName ? { supplierName: input.supplierName } : {}),
        ...(input.invoiceRef ? { invoiceRef: input.invoiceRef } : {}),
        ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
        ...(input.departmentId ? { departmentId: new Types.ObjectId(input.departmentId) } : {}),
        ...(input.departmentName ? { departmentName: input.departmentName } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    ],
    { session },
  );
  if (!row) throw new Error("inventory movement insert returned nothing");
  return toMovement(row);
}

/**
 * The movement history for one item, newest first — the "how did we get to 42" view.
 *
 * SCOPED, unlike the master above it: a movement happened at a site, and a store keeper confined
 * to one must not read another's deliveries and issues.
 */
export async function listMovements(itemId: string, limit = 100): Promise<InventoryMovement[]> {
  if (!Types.ObjectId.isValid(itemId)) return [];
  const docs = await getInventoryMovementModel(getTenantDb())
    .find({ itemId: new Types.ObjectId(itemId), ...scopeFilter() })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<InventoryMovementDoc[]>();
  return docs.map(toMovement);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
