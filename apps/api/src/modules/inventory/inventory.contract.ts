/**
 * General store response contracts.
 *
 * The item master and the supplier list are TENANT-WIDE; the shelf and every movement are
 * BRANCH-SCOPED (ADR-0015). `onHand` on a store row is therefore the balance at the site the
 * caller is looking at — the same number means a different shelf depending on the branch header,
 * which is exactly what the header is for.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import { ITEM_CATEGORIES, ITEM_UNITS, MOVEMENT_KINDS } from "./inventory.model.js";
import type { InventoryItem, InventoryMovement } from "./inventory.repository.js";
import type { Supplier as SupplierDto } from "./supplier.repository.js";
import type { IssueDestination, receive, StoreRow } from "./inventory.service.js";

const itemFields = {
  id: z.string(),
  code: z.string(),
  name: z.string(),
  category: z.enum(ITEM_CATEGORIES),
  unit: z.enum(ITEM_UNITS),
  reorderLevel: z.number(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const inventoryItem = contract("InventoryItem", z.object(itemFields));
export type InventoryItemProof = Proves<Matches<typeof inventoryItem, InventoryItem>>;

/** The item plus what is on this site's shelf, and the verdict the list sorts on. */
export const storeRow = contract(
  "StoreRow",
  z.object({
    ...itemFields,
    onHand: z.number(),
    position: z.enum(["ok", "low", "out"]),
  }),
);
export type StoreRowProof = Proves<Matches<typeof storeRow, StoreRow>>;

export const supplier = contract(
  "Supplier",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    phone: z.string().optional(),
    email: z.string().optional(),
    taxId: z.string().optional(),
    active: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type SupplierProof = Proves<Matches<typeof supplier, SupplierDto>>;

export const inventoryMovement = contract(
  "InventoryMovement",
  z.object({
    id: z.string(),
    itemId: z.string(),
    itemCode: z.string(),
    kind: z.enum(MOVEMENT_KINDS),
    /** Signed: receipts positive, issues negative. */
    delta: z.number(),
    balanceAfter: z.number(),
    /** Captured at the time of the movement — see the service. */
    supplierId: z.string().optional(),
    supplierName: z.string().optional(),
    invoiceRef: z.string().optional(),
    unitCost: z.number().optional(),
    departmentId: z.string().optional(),
    departmentName: z.string().optional(),
    reason: z.string().optional(),
    branchId: z.string().optional(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
);
export type InventoryMovementProof = Proves<Matches<typeof inventoryMovement, InventoryMovement>>;

/** A stock change answers with the item, the new shelf, and the ledger row that produced it. */
export const stockChange = contract(
  "InventoryStockChange",
  z.object({ item: inventoryItem, onHand: z.number(), movement: inventoryMovement }),
);
export type StockChangeProof = Proves<Matches<typeof stockChange, Returns<typeof receive>>>;

/** Where an issue may go — an id and a label, and deliberately nothing else. See the service. */
export const issueDestination = contract(
  "IssueDestination",
  z.object({ id: z.string(), name: z.string() }),
);
export type IssueDestinationProof = Proves<Matches<typeof issueDestination, IssueDestination>>;
