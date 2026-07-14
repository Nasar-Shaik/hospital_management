/**
 * Orders module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * THE SPINE THAT CARRIES WORK BETWEEN DEPARTMENTS (ADR-0013 §3). One polymorphic
 * object — lab, radiology, pharmacy, procedure, referral, admission, diet — placed
 * against an ENCOUNTER, never against a note.
 *
 * Depends on `encounters` (an order is work raised during a visit), `patients`,
 * `users` (the doctor the result goes back to) and `notifications` (a platform
 * module). **`encounters` does NOT depend on this** — the arrow points order →
 * encounter, and the graph stays acyclic.
 *
 * NOT a platform module: healthcare vocabulary throughout (PLATFORM_STRATEGY §2).
 */
export { orderRouter } from "./order.routes.js";
export { orderConsumers } from "./order.consumers.js";

export {
  placeOrder,
  getOrder,
  listOrders,
  acceptOrder,
  startOrder,
  completeOrder,
  verifyOrder,
  releaseOrder,
  cancelOrder,
  hasOutstandingOrders,
  type Order,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type CompleteOrderInput,
} from "./order.service.js";

export {
  ORDER_CATEGORIES,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  canTransition,
  isOutstanding,
  type OrderCategory,
  type OrderPriority,
  type OrderStatus,
  type OrderResultValue,
} from "./order.model.js";
