/**
 * The consumer end of the outbox — the half that finally DOES something (ADR-0007).
 *
 * Pulls domain events and deferred tasks off the `notifications` queue, binds the
 * tenant they belong to, and hands them to whichever module registered an interest.
 *
 * ── WHY THIS RUNS IN apps/api AND NOT apps/workers ──────────────────────────
 * The same reason the relay does, written down in SCHEDULER_CATALOG and worth
 * repeating because it is the question every reviewer asks:
 *
 * Sending an appointment confirmation requires the patient's contact details, the
 * hospital's template, and the dedupe ledger. All three live in the TENANT's
 * database — deliberately, because an event payload carries ids and never PHI
 * (EVENT_CATALOG global rules): the queue is not a safe place for a phone number.
 * Reading a tenant database requires the registry, the Connection Manager and the
 * Mongoose stack, none of which exist in `apps/workers`. Putting the consumer
 * there today means either duplicating that stack or extracting `packages/db`
 * before anything else needs it — a refactor of the crown jewel (MODULE_OWNERSHIP)
 * in service of nothing a hospital can see.
 *
 * So: the API produces AND consumes; the workers keep the `events` queue for
 * consumers that need no database. The extraction trigger is unchanged and now has
 * a second tenant — when the DB layer moves to `packages/db`, this file moves to
 * `apps/workers` unaltered. Nothing about the events changes. That is the seam.
 *
 * ── WHY A SEPARATE QUEUE FROM THE WORKERS' `events` ─────────────────────────
 * Two BullMQ Workers on ONE queue do not both get every job — they SPLIT them.
 * Consuming `events` from here would mean roughly half of all appointments never
 * got a confirmation, and the half that did would look like proof it worked. Each
 * concern gets its own queue (ADR-0007), and the relay fans an event out to every
 * queue that cares (eventCatalog.queuesFor).
 */
import { Worker, type ConnectionOptions } from "bullmq";
import { createLogger } from "@medicore/logger";
import { env } from "../../config/env.js";
import { getContext, runWithContext } from "../context/requestContext.js";
import { getTenantConnection } from "../db/connectionManager.js";
import { getById } from "../../modules/tenants/index.js";
import { appointmentConsumers } from "../../modules/appointments/index.js";
import { orderConsumers } from "../../modules/orders/index.js";
import { billingConsumers } from "../../modules/billing/index.js";
import { prescriptionConsumers } from "../../modules/prescriptions/index.js";
import { medicineConsumers } from "../../modules/medicines/index.js";
import { patientConsumers } from "../../modules/patients/index.js";
import { encounterConsumers } from "../../modules/encounters/index.js";
import { allergyConsumers } from "../../modules/allergies/index.js";
import { vitalsConsumers } from "../../modules/vitals/index.js";
import { dispenseConsumers } from "../../modules/pharmacy/index.js";
import { wardNoteConsumers } from "../../modules/admissions/index.js";
import { reportConsumers } from "../../modules/reports/index.js";
import { documentConsumers } from "../../modules/documents/index.js";
import { walletConsumers } from "../../modules/wallet/index.js";
import { notificationConsumers } from "../../modules/notifications/index.js";
import { NOTIFICATION_QUEUE, TASK_PREFIX, type TaskJob } from "./taskQueue.js";
import type { DomainEvent, EventHandler, ModuleConsumers, TaskHandler } from "./consumers.js";

const logger = createLogger({ service: "event-consumer" });

/**
 * The composition root for reactions.
 *
 * Every module that reacts to something appears here, exactly once. This is the
 * one place to look to answer "what happens when an appointment is booked?" — a
 * question that, in systems where handlers self-register by import side effect,
 * can only be answered by grepping and hoping.
 *
 * `identity.user.created` is NOT here yet, though EVENT_CATALOG lists it. Its
 * welcome mail must carry a single-use invite LINK — the catalog is emphatic that a
 * password must never ride a durable queue — and minting one is the same machinery
 * as forgot-password. Both land together, next. A welcome email that cannot let
 * someone in is a worse product than no welcome email.
 */
const MODULES: ModuleConsumers[] = [
  appointmentConsumers,
  patientConsumers,
  orderConsumers,
  billingConsumers,
  prescriptionConsumers,
  // Decrements the shelf when the pharmacy publishes a handover — see medicine.consumers.ts.
  medicineConsumers,
  // A patient merge fans out to every module that stores a patientId, each re-pointing its
  // OWN references to the survivor (core/events/patientMerge.ts). Several modules above
  // (appointments, orders, prescriptions, billing) also handle it; these are the rest.
  encounterConsumers,
  allergyConsumers,
  vitalsConsumers,
  dispenseConsumers,
  wardNoteConsumers,
  reportConsumers,
  documentConsumers,
  walletConsumers,
  /**
   * The only entry here that reacts to nothing in the hospital. It registers ONE task —
   * `push.deliver` — which this module scheduled for itself when an in-app message was delivered
   * (M4). Push is a knock on the door after the record is already safe, so it runs on the queue
   * with its retries and its DLQ rather than inside the request that raised the alert.
   */
  notificationConsumers,
];

function mergeHandlers(): {
  events: Map<string, EventHandler[]>;
  tasks: Map<string, TaskHandler>;
} {
  const events = new Map<string, EventHandler[]>();
  const tasks = new Map<string, TaskHandler>();

  for (const module of MODULES) {
    for (const [name, handler] of Object.entries(module.events ?? {})) {
      // Several modules may care about one event. All of them run; one failing
      // does not cancel the others (see dispatchEvent).
      events.set(name, [...(events.get(name) ?? []), handler]);
    }
    for (const [name, handler] of Object.entries(module.tasks ?? {})) {
      if (tasks.has(name)) {
        // Two modules claiming one task name is a programming error that would
        // otherwise silently drop one of them.
        throw new Error(`duplicate task handler registered: "${name}"`);
      }
      tasks.set(name, handler);
    }
  }

  return { events, tasks };
}

function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname.length > 1 ? { db: Number(parsed.pathname.slice(1)) } : {}),
    maxRetriesPerRequest: null,
  };
}

/**
 * Binds a tenant for a background job — the same shape of synthetic context the
 * audit CLI uses (scripts/auditChain.ts). A handler therefore reaches its database
 * through exactly the same door a request does; there is no second, privileged path
 * into a tenant's data, which is the whole point of the Connection Manager.
 *
 * `userId` is deliberately absent. Nobody clicked anything — this is the system
 * acting on its own, and the audit trail should say so rather than blame the clerk
 * whose booking happened to trigger it.
 *
 * ── THE BRANCH TRAVELS WITH THE EVENT (ADR-0015) ────────────────────────────
 * `activeBranchId` is bound from the envelope, so a handler reacting to something that
 * happened in Chennai writes its charge, its stock movement and its SMS record in Chennai —
 * through `writeBranchId()`, the same choke point a request uses, with no per-consumer
 * plumbing. Before this, the context carried no branch at all and each consumer had to
 * remember `event.branchId` for itself: billing, medicines, patients and prescriptions did;
 * `order.result.released` did not, and neither did anything reached through `notify()` that
 * had not thought to look it up. Per-consumer plumbing always ends with that split.
 *
 * It also makes the branch survive a RETRY, which per-handler plumbing could not guarantee:
 * the value is re-read from the persisted outbox row on every redelivery, so attempt five
 * binds exactly what attempt one did.
 *
 * `scope` stays absent. There is no user to constrain here, and `writeBranchId` already reads
 * an absent scope as "internal caller, trust the branch" — the same way `scopeFilter` does.
 */
async function withTenant<T>(
  tenantId: string,
  traceId: string,
  fn: () => Promise<T>,
  branchId?: string,
): Promise<T> {
  const tenant = await getById(tenantId);
  if (!tenant) {
    // A tenant that no longer exists (or was terminated) is not a retryable
    // failure — the event will never be deliverable, and retrying it five times
    // just fills the DLQ with a fact that is not going to change.
    logger.warn({ tenantId }, "event for unknown tenant — dropped");
    return undefined as T;
  }

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  return runWithContext(
    {
      traceId,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
      ...(branchId ? { activeBranchId: branchId } : {}),
    },
    fn,
  );
}

/**
 * Runs every handler that cares. One handler failing does NOT stop the others:
 * if the SMS gateway is down, the email should still go out. The job then throws,
 * so BullMQ retries — and the handlers that already succeeded dedupe on the second
 * pass rather than repeating themselves (that is what `dedupeKey` buys).
 */
async function dispatchEvent(handlers: EventHandler[], event: DomainEvent): Promise<void> {
  const results = await Promise.allSettled(handlers.map((handler) => handler(event)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  if (failures.length > 0) {
    const reasons = failures
      .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
      .join("; ");
    throw new Error(`${String(failures.length)} handler(s) failed: ${reasons}`);
  }
}

let worker: Worker | undefined;

export function startEventConsumer(): void {
  if (!env.NOTIFY_CONSUMER_ENABLED) {
    logger.info("event consumer disabled (NOTIFY_CONSUMER_ENABLED=false) — events will queue");
    return;
  }
  if (!env.REDIS_URL) {
    logger.warn("event consumer not started — REDIS_URL is not set; nothing will be delivered");
    return;
  }

  const { events, tasks } = mergeHandlers();

  worker = new Worker(
    NOTIFICATION_QUEUE,
    async (job) => {
      if (job.name.startsWith(TASK_PREFIX)) {
        const { task, tenantId, data } = job.data as TaskJob;
        const handler = tasks.get(task);
        if (!handler) {
          logger.error({ task }, "no handler for task — dropped");
          return;
        }
        await withTenant(tenantId, `task-${task}-${job.id ?? "?"}`, () => handler(data));
        return;
      }

      const event = job.data as DomainEvent;
      const handlers = events.get(event.name);
      if (!handlers || handlers.length === 0) {
        // Routed here by queuesFor() but nothing consumes it. Not an error — it is
        // how a queue looks the day before its consumer ships — but it is worth
        // saying out loud, because it also looks exactly like a handler someone
        // deleted by accident.
        logger.warn({ event: event.name }, "event routed to notifications but has no handler");
        return;
      }

      await withTenant(
        event.tenantId,
        event.traceId ?? `event-${event.eventId}`,
        () => dispatchEvent(handlers, event),
        event.branchId,
      );
    },
    {
      connection: redisConnection(env.REDIS_URL),
      // Modest: every job opens a tenant DB connection and talks to an SMTP server.
      // The Connection Manager caps connections (TENANT_MAX_CONNECTIONS) and a
      // burst of mail is never worth starving HTTP requests in the same process —
      // which is precisely the coupling that ends when this moves to apps/workers.
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    // A job that exhausts its retries stays in the failed set (the DLQ) — it is not
    // removed. An appointment reminder that silently vanished is the failure this
    // entire pattern exists to prevent (ADR-0007).
    logger.error(
      { jobId: job?.id, job: job?.name, attempts: job?.attemptsMade, err },
      "notification job failed",
    );
  });

  logger.info(
    {
      queue: NOTIFICATION_QUEUE,
      events: [...events.keys()],
      tasks: [...tasks.keys()],
    },
    "event consumer started",
  );
}

export async function stopEventConsumer(): Promise<void> {
  await worker?.close();
  worker = undefined;
}

/**
 * Test seam: run one job's worth of dispatch inline, with no Redis and no queue.
 *
 * The queue is BullMQ's problem and it is well tested; what we need to prove is
 * that OUR handlers do the right thing — that a booking produces exactly one
 * confirmation, that a redelivery produces none, that a cancelled appointment's
 * reminder stays unsent. Doing that through a real Redis round-trip would make the
 * suite slow, flaky, and no more truthful.
 */
export async function dispatchEventInline(event: DomainEvent): Promise<void> {
  const { events } = mergeHandlers();
  const handlers = events.get(event.name) ?? [];

  /**
   * The branch is bound here for the same reason `withTenant` binds it, and the duplication is
   * the point: a seam that skipped it would let a test prove a propagation production does not
   * perform. The caller has already bound the tenant (that is what this seam exists to avoid
   * re-doing), so only the branch is layered on.
   */
  if (!event.branchId) {
    await dispatchEvent(handlers, event);
    return;
  }
  await runWithContext({ ...getContext(), activeBranchId: event.branchId }, () =>
    dispatchEvent(handlers, event),
  );
}

export async function dispatchTaskInline(
  task: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { tasks } = mergeHandlers();
  const handler = tasks.get(task);
  if (!handler) throw new Error(`no handler for task "${task}"`);
  await handler(data);
}
