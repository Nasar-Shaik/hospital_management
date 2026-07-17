/**
 * Pharmacy module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Handing the drugs over, and the ledger that records it.
 *
 * An ORCHESTRATOR, like `staff`: it owns one collection (`dispenses`) and coordinates
 * `prescriptions` (what was authorised), `orders` (the worklist entry) and — only by
 * announcing `medication.dispensed` — `billing`. It may depend on all of them precisely
 * because NOTHING depends on it, which is what keeps the graph acyclic.
 *
 * It does NOT own stock. There are no batches, no expiry, no purchasing: this is a counter
 * without a warehouse, and it says so out loud rather than keeping an inventory number
 * that is only sometimes right (see `pharmacy.service.ts`).
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { pharmacyRouter } from "./pharmacy.routes.js";

export {
  dispense,
  dispenseAndClear,
  dispensesFor,
  type Dispense,
  type DispenseInput,
  type DispenseItemInput,
  type DispenseResult,
} from "./pharmacy.service.js";

export type { DispenseLine } from "./dispense.model.js";

/** Re-points dispense records onto the survivor on merge. Registered by eventConsumer.ts. */
export { dispenseConsumers } from "./dispense.consumers.js";
