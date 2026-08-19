/**
 * Notifications module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * A PLATFORM module (PLATFORM_STRATEGY §2). There is not one healthcare word in
 * it, and that is deliberate: when School ERP sends a fee reminder to a parent, it
 * imports this module unchanged. The HMS meaning of a message — that a booking
 * earns a confirmation, that a registration earns a welcome — lives in the modules
 * that own those events (`appointment.consumers.ts`, `patient.consumers.ts`), which
 * call `notify()` from here.
 *
 * `notify()` is the only door. Callers never touch a channel, a transport or the
 * ledger.
 */
import type { ModuleConsumers } from "../../core/events/consumers.js";
import { PUSH_TASK, deliver } from "./push.service.js";

export { notificationRouter } from "./notification.routes.js";

export {
  notify,
  listNotifications,
  listTemplates,
  updateTemplate,
  type NotifyInput,
  type NotifyOutcome,
  type Recipient,
  type Notification,
  type NotificationTemplate,
} from "./notification.service.js";

export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  renderTemplate,
  type NotificationChannel,
  type NotificationStatus,
} from "./notification.model.js";

export { PUSH_TASK, copyFor, shouldPush, deliver as deliverPush } from "./push.service.js";
export { DEVICE_PLATFORMS, type DevicePlatform } from "./device.model.js";
export type { Device } from "./device.repository.js";

/**
 * The module's reactions (core/events/consumers.ts).
 *
 * ── A TASK, NOT AN EVENT, AND THAT IS THE WHOLE DESIGN ──────────────────────
 * This module reacts to nothing that happens in the hospital — it would have to know what an
 * order is, and Rule P1 forbids that. What it registers is deferred work IT scheduled for itself:
 * `notification.service.ts` queues `push.deliver` the moment an in-app message is delivered, and
 * this is the other end of that. The domain's meaning stays in the domain; the delivery stays
 * here.
 */
export const notificationConsumers: ModuleConsumers = {
  tasks: { [PUSH_TASK]: deliver },
};
