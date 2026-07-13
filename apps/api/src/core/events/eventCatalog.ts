/**
 * Domain event names — the code-side mirror of AI_Workflow/docs/EVENT_CATALOG.md.
 *
 * Guidelines §4: every event published through the outbox MUST have a catalog
 * entry in the same PR. This file is what makes that enforceable rather than
 * aspirational — `publish()` accepts only names declared here, so an event cannot
 * reach the queue without a developer first writing down who consumes it and what
 * happens when the consumer fails.
 *
 * Naming: `domain.entity.action`, past tense (Doc 09 §2). Past tense because an
 * event is a statement about something that ALREADY happened and cannot be
 * refused — `patient.registered`, never `registerPatient`. A consumer that treats
 * an event as a command will eventually try to veto the past.
 *
 * Versioning: payload changes are additive. A breaking change publishes
 * `name` at `version + 1` ALONGSIDE the old version for one deprecation cycle,
 * because the consumers are not deployed at the same instant as the producer.
 */

export const EVENTS = {
  /* ── Platform (PLATFORM_STRATEGY §2 — no healthcare vocabulary) ─────────── */

  /** A new hospital's database has been created, migrated and seeded. */
  TENANT_PROVISIONED: "platform.tenant.provisioned",
  /** A hospital moved between editions — entitlement caches must fan out. */
  SUBSCRIPTION_CHANGED: "platform.subscription.changed",
  /** A hospital crossed 80% or 100% of a plan limit. Sales cares; so does the admin. */
  LIMIT_THRESHOLD_REACHED: "platform.limit.thresholdReached",

  /* ── Identity ───────────────────────────────────────────────────────────── */

  /** A staff account was created. Consumer (A6): the welcome/credentials email. */
  USER_CREATED: "identity.user.created",
  /** An account was disabled — sessions are already dead; downstream systems must catch up. */
  USER_DISABLED: "identity.user.disabled",
  /** A role binding changed. Consumer: permission cache invalidation across pods. */
  USER_ROLES_CHANGED: "identity.user.rolesChanged",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * The queue each event is dispatched to (ADR-0007: one queue per concern).
 *
 * Everything lands on `events` today because no consumer is specialized yet.
 * When notifications (A6) arrives it gets its own queue and its own concurrency
 * budget, so a backlog of welcome emails can never delay a panic-value alert.
 */
export const EVENT_QUEUE = "events";
