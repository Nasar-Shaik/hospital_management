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

  /* ── Patients (Doc 02 C1) ───────────────────────────────────────────────── */

  /** A patient was registered. Consumers (A6): welcome message; analytics. */
  PATIENT_REGISTERED: "patient.patient.registered",
  /**
   * Two records were found to be the same person.
   *
   * The single most important event in this catalog for anything built later.
   * EVERY module that stores a `patientId` — appointments, visits, bills, lab
   * orders, prescriptions — must consume this and re-point its references, or it
   * will keep serving a chart that a human has already declared obsolete.
   *
   * The merged record is NOT deleted, so a consumer that misses this event is
   * stale rather than broken. Consumers must be idempotent: at-least-once
   * delivery means they will see it twice, and re-pointing an already-re-pointed
   * reference must be a no-op (ADR-0007).
   */
  PATIENTS_MERGED: "patient.patients.merged",

  /* ── Encounters (Doc 02 E0, ADR-0013) ───────────────────────────────────── */

  /**
   * A patient is in the building — booked, walked in, or brought in.
   *
   * The CENTRAL clinical event. Consumers do not care which origin it was, and that
   * indifference is the architecture: a government hospital that never books an
   * appointment produces exactly this event, hundreds of times a day.
   *
   * Consumers: the queue board; notifications; analytics. Later: the work-queue
   * projection (ADR-0014), which turns this into a doctor's work item.
   */
  ENCOUNTER_STARTED: "encounter.encounter.started",
  /**
   * The visit is over. Consumers: billing (the OP bill is assembled from charges
   * posted against this encounter), MRD, analytics.
   *
   * NOT the same as discharge — an encounter that ends in `admitted` opens an
   * INPATIENT encounter in the same Episode of Care rather than closing the story.
   */
  ENCOUNTER_CLOSED: "encounter.encounter.closed",

  /* ── Appointments (Doc 02 E1) ───────────────────────────────────────────── */

  /**
   * A slot was booked. Consumer (A6): the confirmation message, and the reminder
   * job scheduled for the day before — which is the single highest-value
   * notification in the product, because a reminder that lands is a no-show that
   * does not happen, and an empty slot is revenue the hospital cannot recover.
   */
  APPOINTMENT_BOOKED: "appointment.appointment.booked",
  /**
   * A slot was given up. Consumers: notifications, and (later) the waiting list,
   * which promotes someone into the freed slot. Promotion MUST be idempotent —
   * at-least-once delivery means a duplicate would otherwise promote two people
   * into one slot, which is the very thing the unique index exists to prevent.
   */
  APPOINTMENT_CANCELLED: "appointment.appointment.cancelled",

  /* ── Orders (ADR-0013 §3) — the spine between departments ────────────────── */

  /**
   * A doctor ordered something: a test, a scan, a drug, a procedure, a referral.
   *
   * THIS EVENT IS THE HAND-OFF. "Doctor orders appear automatically in the
   * destination department" is not a queue feature and not a screen — it is this
   * event reaching the department that has to do the work. There is no paper, no
   * phone call, and no separate "send to lab" step that somebody can forget.
   *
   * Consumers: the destination department's worklist; (later) the work-queue
   * projection (ADR-0014), for which this is the SECOND and THIRD producer and
   * therefore the thing that finally makes a universal queue worth building.
   */
  ORDER_PLACED: "order.order.placed",
  /**
   * The order was called off. Consumers: the destination department (drop the work
   * item — the patient is not coming), billing (do not charge for it).
   *
   * Must be idempotent: cancelling an already-cancelled order is a no-op, and
   * at-least-once delivery guarantees the consumer will see this twice.
   */
  ORDER_CANCELLED: "order.order.cancelled",
  /**
   * The result is signed, released, and now visible to the doctor who ordered it.
   *
   * The RETURN half of the spine. Consumers: notifications (tell the ordering
   * doctor); encounters (a patient parked in `awaiting_results` with nothing left
   * outstanding becomes actionable again — see `order.consumers.ts`).
   *
   * `released`, NOT `completed` or `verified`, because a result that has been run
   * but not signed off must never reach the person who will act on it.
   */
  RESULT_RELEASED: "order.result.released",
  /**
   * A result carries a value that can kill the patient today — a potassium of 7.2,
   * a haemoglobin of 3.
   *
   * ── THIS EVENT IS THE AUDIT TRAIL, NOT THE ALERT ────────────────────────────
   * The alert itself is raised SYNCHRONOUSLY, inside the call that recorded the
   * result, before this event is ever published (see `order.service.ts`). The
   * outbox is durable, but "durable" and "fast" are different promises, and a relay
   * that is a minute behind is a fine place for a welcome email and an
   * unconscionable one for a critical potassium.
   *
   * So this event exists to make the alert AUDITABLE and to fan it out to anyone
   * else who cares. It is not the path the warning travels down.
   */
  CRITICAL_RESULT_FLAGGED: "order.result.criticalFlagged",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * The general fan-out queue, consumed by `apps/workers`.
 *
 * Every event still lands here. Its consumer does nothing but acknowledge and log
 * today — which is not waste: it keeps the whole pipe (publish → commit → relay →
 * queue → handler) exercised on every login and every booking, so we do not first
 * discover the pipe is broken on the day a discharge summary depends on it.
 */
export const EVENT_QUEUE = "events";

/**
 * The notifications queue, consumed IN-PROCESS by the API (core/events/eventConsumer.ts).
 * Its own queue and its own concurrency budget — exactly as this file promised
 * when it said "when notifications (A6) arrives it gets its own queue", so a
 * backlog of welcome emails can never delay a panic-value alert.
 */
export const NOTIFICATION_QUEUE = "notifications";

/**
 * Which queues an event is delivered to (ADR-0007: one queue per concern).
 *
 * ── AN EVENT GOES TO EVERY QUEUE THAT CARES, NOT TO ONE ─────────────────────
 * This is a topic fan-out, and the duplication is the point. Two BullMQ Workers on
 * the SAME queue do not each get every job — they split them. So if the API's
 * notification consumer and the workers' consumer both sat on `events`, roughly
 * half of all bookings would never produce a confirmation, and the other half would
 * look like proof that it worked. That bug is invisible in a demo and obvious to a
 * patient.
 *
 * A separate queue per concern also means separate retry budgets: a mail server
 * outage retries emails without re-running analytics, and a poisoned analytics job
 * cannot block a reminder.
 *
 * The same `eventId` is used as the BullMQ job id in each queue, so redelivery is
 * still collapsed per queue, and consumers still dedupe (at-least-once, always).
 */
const NOTIFYING_EVENTS = new Set<string>([
  EVENTS.PATIENT_REGISTERED,
  EVENTS.APPOINTMENT_BOOKED,
  EVENTS.APPOINTMENT_CANCELLED,
  // The report reaching the doctor who asked for it. Note that CRITICAL_RESULT_FLAGGED
  // is deliberately NOT here: its alert has already been raised synchronously by the
  // time it is published, and routing it through a queue as well would make the
  // warning arrive twice while teaching us to believe the queue was fast enough.
  EVENTS.RESULT_RELEASED,
]);

export function queuesFor(name: string): string[] {
  return NOTIFYING_EVENTS.has(name) ? [EVENT_QUEUE, NOTIFICATION_QUEUE] : [EVENT_QUEUE];
}
