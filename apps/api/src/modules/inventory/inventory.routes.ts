/**
 * General store routes.
 *
 * ── GATED ON `module.support.inventory` ─────────────────────────────────────
 * The store room is a department a hospital either runs or does not. A clinic does not, which is
 * why the flag is in the Hospital editions and not in `CLINIC_FLAGS` — and why every route here
 * carries it, including the reads. An unentitled hospital gets `HMS-PLAN-002`, and the web nav
 * never offers the screen in the first place (D20).
 *
 * ── THE PERMISSIONS ARE FOUR JOBS, NOT FOUR RANKS ───────────────────────────
 * `inventory:manage` is the BASELINE and gates every read: a person who may not see the shelf
 * cannot usefully do anything else here. On top of it sit the three acts, separately grantable so
 * a hospital can split them across real people:
 *
 *   purchase → booking a delivery IN         (the money-facing act)
 *   issue    → handing stock OUT             (the one that runs all day)
 *   audit    → correcting the count          (deliberately NOT the same person as `issue`)
 *
 * `vendor:manage` is its own thing again — the supplier master is a master, and the person who
 * maintains who the hospital buys from is not necessarily the person at the counting desk.
 *
 * All five were declared `future()` in the catalogue until this module shipped, and all five were
 * held by TENANT_ADMIN alone. `STORE_KEEPER` is the role that makes them reachable by the person
 * whose job this actually is — see `@medicore/permissions`.
 */
import { Router } from "express";
import { FEATURE_FLAGS, PERMISSIONS } from "@medicore/permissions";
import { asyncHandler } from "../../core/http/asyncHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { responds } from "../../middleware/responds.js";
import { idempotent } from "../../middleware/idempotent.js";
import * as controller from "./inventory.controller.js";
import {
  inventoryItem,
  inventoryMovement,
  issueDestination,
  stockChange,
  storeRow,
  supplier,
} from "./inventory.contract.js";
import {
  adjustSchema,
  createItemSchema,
  createSupplierSchema,
  idParamSchema,
  issueSchema,
  receiveSchema,
  storeQuerySchema,
  supplierQuerySchema,
  updateItemSchema,
  updateSupplierSchema,
} from "./inventory.schema.js";

const FEATURE = { feature: FEATURE_FLAGS.SUPPORT_INVENTORY } as const;

export function inventoryRouter(): Router {
  const router = Router();

  /* ── suppliers ──────────────────────────────────────────────────────────── */

  router.get(
    "/suppliers",
    authenticate(),
    authorize(PERMISSIONS.VENDOR_MANAGE, FEATURE),
    validate(supplierQuerySchema, "query"),
    responds(supplier.array()),
    asyncHandler(controller.listSuppliers),
  );

  router.post(
    "/suppliers",
    authenticate(),
    authorize(PERMISSIONS.VENDOR_MANAGE, FEATURE),
    validate(createSupplierSchema),
    responds(supplier, { status: 201 }),
    asyncHandler(controller.createSupplier),
  );

  router.patch(
    "/suppliers/:id",
    authenticate(),
    authorize(PERMISSIONS.VENDOR_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateSupplierSchema),
    responds(supplier),
    asyncHandler(controller.updateSupplier),
  );

  /* ── the store list ─────────────────────────────────────────────────────── */

  router.get(
    "/inventory-items",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_MANAGE, FEATURE),
    validate(storeQuerySchema, "query"),
    responds(storeRow.array()),
    asyncHandler(controller.listItems),
  );

  /**
   * Where an issue may go. `inventory:manage` — the store's baseline — and NOT a department
   * permission: see `listDestinations` for why a store keeper must not be handed `patient:read`
   * just to fill in a picker.
   */
  router.get(
    "/inventory-destinations",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_MANAGE, FEATURE),
    responds(issueDestination.array()),
    asyncHandler(controller.destinations),
  );

  router.get(
    "/inventory-items/:id/movements",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    responds(inventoryMovement.array()),
    asyncHandler(controller.movements),
  );

  router.post(
    "/inventory-items",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_MANAGE, FEATURE),
    validate(createItemSchema),
    responds(inventoryItem, { status: 201 }),
    asyncHandler(controller.createItem),
  );

  router.patch(
    "/inventory-items/:id",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_MANAGE, FEATURE),
    validate(idParamSchema, "params"),
    validate(updateItemSchema),
    responds(inventoryItem),
    asyncHandler(controller.updateItem),
  );

  /* ── the three verbs ────────────────────────────────────────────────────────
   * All three are `idempotent()`. A store keeper on a bad connection who presses Receive twice
   * must book ONE delivery, not two — and unlike a duplicate read, a duplicate movement is a
   * number that stays wrong until somebody counts the shelf by hand.
   */

  router.post(
    "/inventory-items/:id/receive",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_PURCHASE, FEATURE),
    validate(idParamSchema, "params"),
    validate(receiveSchema),
    responds(stockChange, { status: 201 }),
    idempotent("Replays the delivery this key already booked in."),
    asyncHandler(controller.receive),
  );

  router.post(
    "/inventory-items/:id/issue",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_ISSUE, FEATURE),
    validate(idParamSchema, "params"),
    validate(issueSchema),
    responds(stockChange, { status: 201 }),
    idempotent("Replays the issue this key already made."),
    asyncHandler(controller.issue),
  );

  router.post(
    "/inventory-items/:id/adjust",
    authenticate(),
    authorize(PERMISSIONS.INVENTORY_AUDIT, FEATURE),
    validate(idParamSchema, "params"),
    validate(adjustSchema),
    responds(stockChange, { status: 201 }),
    idempotent("Replays the correction this key already made."),
    asyncHandler(controller.adjust),
  );

  return router;
}
