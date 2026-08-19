/**
 * General store module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Modules G1/G3).
 *
 * Owns the non-drug store: the item master, each site's shelf, the supplier list, and the ledger
 * of everything that moved. It depends on `departments` (an issue has to arrive somewhere) and on
 * nothing else operational; nothing operational depends on it. The graph stays acyclic.
 *
 * It deliberately does NOT touch the pharmacy. Drugs have their own master, their own batches and
 * their own FEFO rule, and the two shelves are two rooms.
 */
export { inventoryRouter } from "./inventory.routes.js";

export {
  listStore,
  createItem,
  updateItem,
  listMovements,
  listDestinations,
  receive,
  issue,
  adjust,
  listSuppliers,
  createSupplier,
  updateSupplier,
  ITEM_CATEGORIES,
  ITEM_UNITS,
  MOVEMENT_KINDS,
} from "./inventory.service.js";

export type {
  InventoryItem,
  InventoryMovement,
  IssueDestination,
  ItemCategory,
  ItemUnit,
  MovementKind,
  StockPosition,
  StoreRow,
  Supplier,
} from "./inventory.service.js";
