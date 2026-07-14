/**
 * Deferred work — "do this later, once" (ADR-0007).
 *
 * An event says something HAPPENED. A task says something SHOULD HAPPEN, at a
 * time of the caller's choosing. The day-before appointment reminder is the first
 * of these: nothing has occurred at 09:00 tomorrow, and yet that is when the
 * patient needs to hear from us.
 *
 * ── WHY THIS FILE IS SEPARATE FROM eventConsumer.ts ──────────────────────────
 * Not taste — the boundary checker. `eventConsumer` imports the modules (to reach
 * their handlers); the modules import THIS (to schedule work). If both lived in
 * one file, `appointments → eventConsumer → appointments` would be a cycle, and
 * `no-circular` is release-gating (dependency-cruiser). One file, one direction.
 *
 * ── WHY NOT A CRON THAT SCANS ────────────────────────────────────────────────
 * SCHEDULER_CATALOG describes `reminder.appointments` as a 5-minute sweep over
 * everything due. A delayed job instead: the work is scheduled at the moment its
 * cause occurs, so nothing wakes up every five minutes to ask a database whether
 * there is anything to do — which, for a clinic with a slow Tuesday, is 288 empty
 * scans a day, per tenant.
 *
 * The sweep's one genuine advantage is that it recovers work whose scheduling was
 * lost. We do not need that: the *event* that schedules the task is durable in the
 * outbox, so a task lost with its Redis instance is rescheduled when the event is
 * redelivered. Durability lives in the outbox, once, rather than in every consumer.
 */
import { Queue, type ConnectionOptions } from "bullmq";
import { createLogger } from "@medicore/logger";
import { env } from "../../config/env.js";

const logger = createLogger({ service: "task-queue" });

/**
 * Notifications get their own queue and their own concurrency budget — exactly as
 * eventCatalog.ts promised they would when A6 arrived. A thousand queued welcome
 * emails must not be able to delay a panic-lab-value alert, and one queue for
 * everything is how that happens.
 */
export const NOTIFICATION_QUEUE = "notifications";

/** Job names on that queue starting with this are tasks, not domain events. */
export const TASK_PREFIX = "task:";

export interface TaskJob {
  task: string;
  tenantId: string;
  data: Record<string, unknown>;
}

/** BullMQ manages its own ioredis connection from options (see apps/workers/main.ts). */
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

let queue: Queue | undefined;

/** Lazily opened so a test or a CLI that never schedules anything opens no socket. */
function getQueue(): Queue | undefined {
  if (!env.REDIS_URL) return undefined;
  queue ??= new Queue(NOTIFICATION_QUEUE, { connection: redisConnection(env.REDIS_URL) });
  return queue;
}

export interface ScheduleOptions {
  /** How long from now. Anything <= 0 runs as soon as a consumer picks it up. */
  delayMs?: number;
  /**
   * The idempotency key for the SCHEDULE itself.
   *
   * BullMQ refuses a duplicate jobId, so re-handling an event (at-least-once —
   * it will happen) re-schedules nothing. Without this, a redelivered
   * `appointment.booked` would queue a SECOND reminder for the same appointment,
   * and the patient would be told twice, a day apart from nothing.
   */
  jobId: string;
}

/**
 * Schedules `task` to run once, later, for one tenant.
 *
 * Returns false when there is no queue (no Redis). That is not a silent failure:
 * the caller is a consumer running under a durable event, so the work is
 * rescheduled the next time that event is delivered. It IS logged, because a
 * production pod that cannot schedule reminders is a real problem wearing a small
 * hat.
 */
export async function scheduleTask(
  task: string,
  tenantId: string,
  data: Record<string, unknown>,
  options: ScheduleOptions,
): Promise<boolean> {
  const q = getQueue();
  if (!q) {
    logger.warn({ task, tenantId }, "no REDIS_URL — task not scheduled");
    return false;
  }

  const payload: TaskJob = { task, tenantId, data };

  await q.add(`${TASK_PREFIX}${task}`, payload, {
    jobId: options.jobId,
    delay: Math.max(0, options.delayMs ?? 0),
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    // The DLQ. A failed task stays visible until an operator looks at it —
    // silent DLQ growth is an incident (ADR-0007), not a cleanup chore.
    removeOnFail: false,
  });

  logger.debug(
    { task, tenantId, delayMs: options.delayMs, jobId: options.jobId },
    "task scheduled",
  );
  return true;
}

export async function closeTaskQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
