/**
 * What a module registers when it wants to react to something.
 *
 * ── WHY MODULES OWN THEIR OWN REACTIONS ─────────────────────────────────────
 * The obvious design is to put every "when X happens, send Y" rule inside the
 * notifications module. It is also wrong, and PLATFORM_STRATEGY Rule P1 says so:
 * the notifications module must not know what an appointment is, or a School ERP
 * inherits a module that talks about doctors.
 *
 * So the rule lives with the domain that owns the event. `appointments` knows that
 * a booking deserves a confirmation and a reminder — that is a CLINICAL policy, not
 * a messaging one, and a hospital that wants to change it will look for it in the
 * appointment book. The notifications module just delivers what it is handed.
 *
 * The cost is one indirection (this registry). The benefit is that the platform's
 * most reusable module stays free of the product's vocabulary, which is a bet worth
 * far more than the indirection costs.
 */

/** The envelope the relay puts on the wire (EVENT_CATALOG global rules). */
export interface DomainEvent {
  eventId: string;
  name: string;
  version: number;
  tenantId: string;
  branchId?: string;
  occurredAt: string;
  actorId?: string;
  traceId?: string;
  payload: Record<string, unknown>;
}

/**
 * Runs with the tenant's context already bound (`getTenantDb()` works).
 *
 * MUST be idempotent — delivery is at-least-once and this handler WILL see the
 * same event twice (ADR-0007). Dedupe on `event.eventId`; for anything that sends
 * a message, `notify({ dedupeKey })` already does it for you.
 *
 * A throw retries the job. Throw for OUR failures (the database was down); do not
 * throw for the world's (a patient with no email address) — see notification.service.
 */
export type EventHandler = (event: DomainEvent) => Promise<void>;

/** Deferred work, scheduled by a handler (taskQueue.ts). Also tenant-bound. */
export type TaskHandler = (data: Record<string, unknown>) => Promise<void>;

/**
 * A module's reactions. Keys are event names / task names; a module exports one of
 * these from its index.ts and the consumer merges them (eventConsumer.ts).
 */
export interface ModuleConsumers {
  events?: Record<string, EventHandler>;
  tasks?: Record<string, TaskHandler>;
}
