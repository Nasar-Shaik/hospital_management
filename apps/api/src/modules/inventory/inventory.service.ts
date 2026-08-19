/**
 * General store service — the item master, the shelf, and the three ways stock moves.
 *
 * ── THE WHOLE MODULE IS THREE VERBS ─────────────────────────────────────────
 * RECEIVE a delivery from a supplier, ISSUE stock to a department, ADJUST the count after a
 * stock-take. Everything else a store does — reordering, costing, returns — is either a report
 * over these three or is procurement software we are not building.
 *
 * ── THE BRANCH IS RESOLVED HERE, NOT TAKEN FROM THE CALLER ──────────────────
 * Every one of the three stamps a site, through `writeBranchId()` (ADR-0015), which is also what
 * refuses `HMS-BRANCH-001` when the caller can reach several sites and has picked none. That is
 * deliberate: the pharmacy shipped `receiveStock` with a `branchId` argument the controller never
 * passed and wrote 31 branchless rows before anybody noticed. The choke point is the fix.
 *
 * ── A NAME IS CAPTURED, NOT JOINED ──────────────────────────────────────────
 * A movement stores the supplier's and department's NAME as well as its id. That is not
 * denormalisation for speed (though it does mean the history screen needs no second request); it
 * is what a ledger is FOR. Renaming a department next year must not rewrite what last year's
 * issue slip said, and a supplier the hospital stops using must not blank out the deliveries it
 * made. The id stays for anyone who wants to follow it forward.
 */
import { AppError } from "../../core/errors/appError.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { withTransaction } from "../../core/db/transaction.js";
import { getDepartment, listDepartments } from "../departments/index.js";
import * as repo from "./inventory.repository.js";
import * as suppliers from "./supplier.repository.js";
import { positionOf, type StockPosition } from "./inventory.model.js";

export type { InventoryItem, InventoryMovement } from "./inventory.repository.js";
export type { Supplier } from "./supplier.repository.js";
export type { ItemCategory, ItemUnit, MovementKind, StockPosition } from "./inventory.model.js";
export { ITEM_CATEGORIES, ITEM_UNITS, MOVEMENT_KINDS } from "./inventory.model.js";

export const listMovements = repo.listMovements;
export const listSuppliers = suppliers.list;

/* ── the master ────────────────────────────────────────────────────────────── */

export async function createItem(input: repo.CreateItemInput): Promise<repo.InventoryItem> {
  try {
    return await repo.createItem(input);
  } catch (err) {
    if (repo.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That item code is already in the store list", {
        code: input.code,
        hint: "codes are unique per hospital — pick another, or edit the existing item",
      });
    }
    throw err;
  }
}

export async function updateItem(
  id: string,
  patch: repo.UpdateItemInput,
): Promise<repo.InventoryItem> {
  const updated = await repo.updateItem(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Item not found", { id });
  return updated;
}

/** An item with what is actually on the shelf the caller is looking at. */
export interface StoreRow extends repo.InventoryItem {
  onHand: number;
  position: StockPosition;
}

export interface ListStoreFilter extends repo.ListItemsFilter {
  /** Only items at or below a POSITIVE reorder level, plus anything that has run out. */
  lowStockOnly?: boolean;
}

/**
 * The store list — every item with its position, worst first.
 *
 * ── WHY THE LOW-STOCK FILTER IS APPLIED HERE AND NOT IN THE QUERY ───────────
 * The medicine master can filter on `$expr` because its balance is a field on the same document.
 * Here the balance lives in `inventoryStock` (per site) and the reorder level on the master, so
 * "low" is a comparison ACROSS two collections and only exists once they are joined. Doing it in
 * memory over a hospital's item list — hundreds of rows, not millions — is the honest cost of
 * having a per-site balance at all, and it is one `$in` either way.
 */
export async function listStore(filter: ListStoreFilter = {}): Promise<StoreRow[]> {
  const items = await repo.listItems(filter);
  const onHand = await repo.stockByItem(items.map((i) => i.id));

  const rank: Record<StockPosition, number> = { out: 0, low: 1, ok: 2 };
  return items
    .map((item) => {
      const balance = onHand.get(item.id) ?? 0;
      return { ...item, onHand: balance, position: positionOf(balance, item.reorderLevel) };
    })
    .filter((row) => !filter.lowStockOnly || row.position !== "ok")
    .sort((a, b) => rank[a.position] - rank[b.position] || a.name.localeCompare(b.name));
}

/* ── suppliers ─────────────────────────────────────────────────────────────── */

export async function createSupplier(
  input: suppliers.CreateSupplierInput,
): Promise<suppliers.Supplier> {
  try {
    return await suppliers.create(input);
  } catch (err) {
    if (suppliers.isDuplicateKey(err)) {
      throw new AppError("HMS-VAL-001", 409, "That supplier code is already in use", {
        code: input.code,
        hint: "codes are unique per hospital",
      });
    }
    throw err;
  }
}

export async function updateSupplier(
  id: string,
  patch: suppliers.UpdateSupplierInput,
): Promise<suppliers.Supplier> {
  const updated = await suppliers.update(id, patch);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "Supplier not found", { id });
  return updated;
}

/**
 * Where stock may be issued TO.
 *
 * ── WHY THIS IS THE STORE'S QUESTION AND NOT A DEPARTMENT READ ──────────────
 * `GET /departments` is gated on `patient:read` — a proxy that was correct while every caller was
 * clinical, and that breaks on the first caller who is not. A store keeper must NOT hold
 * `patient:read`: it would hand the person who counts gloves every patient record in the hospital,
 * which is precisely the "grant a broad permission to make a screen work" mistake the catalogue
 * exists to avoid. Granting it would have been invisible in review and wrong forever.
 *
 * So the store answers its own question, under its own permission, with the SMALLEST honest
 * answer: an id and a name. No kind, no parent, no head, no description — a destination picker
 * needs a label and a value, and a store keeper learns nothing about the hospital's structure
 * beyond where a box of gloves may go.
 *
 * Only ACTIVE departments: a closed department is not somewhere stock can arrive.
 */
export interface IssueDestination {
  id: string;
  name: string;
}

export async function listDestinations(): Promise<IssueDestination[]> {
  const departments = await listDepartments();
  return departments
    .filter((d) => d.status === "active")
    .map((d) => ({ id: d.id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ── the three verbs ───────────────────────────────────────────────────────── */

export interface StockChange {
  item: repo.InventoryItem;
  onHand: number;
  movement: repo.InventoryMovement;
}

async function itemOr404(id: string): Promise<repo.InventoryItem> {
  const item = await repo.findItemById(id);
  if (!item) throw new AppError("HMS-GEN-404", 404, "Item not found", { id });
  return item;
}

/** Positive whole numbers only — a store counts boxes, never 2.5 of them. */
function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError("HMS-VAL-001", 400, "Quantity must be a positive whole number", {
      quantity,
    });
  }
}

export interface ReceiveInput {
  quantity: number;
  supplierId?: string;
  invoiceRef?: string;
  unitCost?: number;
}

/** Books a delivery IN, against a supplier. */
export async function receive(id: string, input: ReceiveInput): Promise<StockChange> {
  assertQuantity(input.quantity);
  const item = await itemOr404(id);
  const branchId = await writeBranchId();

  /**
   * An unknown supplier is REFUSED rather than dropped. A receipt that quietly forgets the
   * supplier the store keeper chose is worse than one that never had it: the screen says the
   * delivery was attributed and the ledger says it was not. (Same reasoning as D14's refused
   * transfer overwriting a real destination.)
   */
  const supplier = input.supplierId ? await suppliers.findById(input.supplierId) : undefined;
  if (input.supplierId && !supplier) {
    throw new AppError("HMS-GEN-404", 404, "Supplier not found", { supplierId: input.supplierId });
  }

  const result = await withTransaction((session) =>
    repo.add(
      item,
      {
        kind: "receipt",
        delta: input.quantity,
        ...(branchId ? { branchId } : {}),
        ...(supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
        ...(input.invoiceRef ? { invoiceRef: input.invoiceRef } : {}),
        ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
      },
      session,
    ),
  );

  return { item, onHand: result.onHand, movement: result.movement };
}

export interface IssueInput {
  quantity: number;
  departmentId: string;
}

/**
 * Hands stock OUT to a department — the movement that runs all day.
 *
 * ── AND THE ONE THAT CAN BE REFUSED ─────────────────────────────────────────
 * Unlike a pharmacy dispense, this is refused when the shelf cannot cover it (`HMS-INV-002`).
 * The pharmacy's rule — record the shortfall rather than block, because the drugs have already
 * crossed the counter — does not apply: nothing has left the store yet, the store keeper is
 * holding the box, and an issue of forty from a shelf of thirty is a mistake being made now
 * rather than a fact to write down.
 */
export async function issue(id: string, input: IssueInput): Promise<StockChange> {
  assertQuantity(input.quantity);
  const item = await itemOr404(id);

  /**
   * The destination is checked BEFORE the branch is resolved and before anything is written. An
   * issue to a department that does not exist is stock that has left the store and arrived
   * nowhere — the ledger would balance and the hospital would have lost it.
   */
  const department = await getDepartment(input.departmentId);
  if (!department) {
    throw new AppError("HMS-GEN-404", 404, "Department not found", {
      departmentId: input.departmentId,
    });
  }

  const branchId = await writeBranchId();

  const result = await withTransaction((session) =>
    repo.take(
      item,
      {
        kind: "issue",
        delta: -input.quantity,
        departmentId: department.id,
        departmentName: department.name,
        ...(branchId ? { branchId } : {}),
      },
      session,
    ),
  );

  if (!repo.wasTaken(result)) {
    throw new AppError("HMS-INV-002", 422, "Not enough stock on the shelf to issue that", {
      requested: input.quantity,
      onHand: result.onHand,
      unit: item.unit,
      hint:
        result.onHand === 0
          ? "this site has none of that item — receive a delivery first"
          : "issue what is there, or receive a delivery first",
    });
  }
  return { item, onHand: result.onHand, movement: result.movement };
}

export interface AdjustInput {
  /** Signed: negative writes stock off, positive corrects it up. Non-zero. */
  delta: number;
  reason: string;
}

/**
 * A correction against a physical count — breakage, a write-off, a stock-take that found the
 * truth. Held apart from `issue` on purpose: a clerk who can both take stock out AND rewrite the
 * number to match leaves no shortfall anybody can see.
 *
 * A downward correction below zero is refused for the same reason an over-issue is. "Minus six
 * gloves" is not a state a room can be in, and accepting it would put a number on the screen that
 * every later reader has to remember is a lie.
 */
export async function adjust(id: string, input: AdjustInput): Promise<StockChange> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new AppError("HMS-VAL-001", 400, "An adjustment must be a non-zero whole number", {
      delta: input.delta,
    });
  }
  const item = await itemOr404(id);
  const branchId = await writeBranchId();

  /**
   * The only caller that chooses at RUNTIME which way stock moves, because an adjustment is the
   * only verb that can go either way. Correcting UP can always succeed; correcting DOWN is
   * refused past zero, exactly like an issue.
   */
  const movement = {
    kind: "adjustment" as const,
    delta: input.delta,
    reason: input.reason,
    ...(branchId ? { branchId } : {}),
  };
  const result = await withTransaction((session) =>
    input.delta > 0 ? repo.add(item, movement, session) : repo.take(item, movement, session),
  );

  if (!repo.wasTaken(result)) {
    throw new AppError("HMS-INV-002", 422, "That correction would take the shelf below zero", {
      requested: input.delta,
      onHand: result.onHand,
      unit: item.unit,
      hint: "write off at most what the shelf holds",
    });
  }
  return { item, onHand: result.onHand, movement: result.movement };
}
