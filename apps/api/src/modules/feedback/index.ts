/**
 * Feedback module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module B10).
 *
 * Owns the feedback & complaint register. A leaf: it depends on nothing operational (a linked
 * patient is stored as an opaque id, never joined) and nothing depends on it, so the graph stays
 * acyclic.
 */
export { feedbackRouter } from "./feedback.routes.js";

export {
  listTickets,
  getTicket,
  createTicket,
  assignTicket,
  transitionTicket,
  type FeedbackTicket,
} from "./feedback.service.js";

export {
  FEEDBACK_KINDS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CHANNELS,
  COMPLAINT_SEVERITIES,
  FEEDBACK_STATUSES,
  canTransition,
  type FeedbackKind,
  type FeedbackCategory,
  type FeedbackChannel,
  type ComplaintSeverity,
  type FeedbackStatus,
} from "./feedback.model.js";

/** Re-points linked feedback tickets onto the survivor on merge. Registered by eventConsumer.ts. */
export { feedbackConsumers } from "./feedback.consumers.js";
