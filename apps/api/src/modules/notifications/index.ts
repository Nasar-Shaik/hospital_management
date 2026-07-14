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
