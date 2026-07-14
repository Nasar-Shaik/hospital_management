/**
 * The outbox relay — the half of the pattern that actually delivers (ADR-0007).
 *
 * Loop: for every servable hospital, claim due events from its `outboxEvents`,
 * enqueue each onto BullMQ, mark it sent. A failure leaves the row in the outbox
 * with a backoff, so nothing is lost by a Redis blip, a deploy, or a kill -9 —
 * the event is already committed to durable storage, and this loop is merely a
 * courier that can be restarted.
 *
 * DELIVERY IS AT-LEAST-ONCE, AND THAT IS A DESIGN CHOICE
 * -----------------------------------------------------
 * Between `enqueue` and `markSent` there is a window. Crash inside it and the
 * event is enqueued but still `processing`; the stale-claim reclaim will send it
 * again. The alternative — mark first, then enqueue — swaps duplicate delivery
 * for LOST delivery, and a lost "panic lab value" notification is a different
 * kind of incident from a duplicate one. So we choose duplicates, and require
 * every consumer to dedupe on `eventId` (ADR-0007).
 *
 * WHY IT RUNS IN THE API AND NOT IN `apps/workers`
 * -----------------------------------------------
 * The relay must read every tenant's database, which means the tenant registry,
 * the Connection Manager and the migration-aware Mongoose stack — all of which
 * live in `apps/api`. `apps/workers` has no database layer at all today, so
 * moving the relay there would mean duplicating that stack or extracting it into
 * a package before anything needs it. Instead: the API *produces* (this file),
 * the workers *consume* (apps/workers). A Redis lock keeps exactly one API pod
 * relaying, so the loop does not multiply with the pod count.
 *
 * The extraction trigger is written down so it is not a matter of taste: when
 * relay lag becomes a scaling concern in its own right, lift the DB layer into
 * `packages/db` and move this loop to `apps/workers`. Nothing about the events
 * themselves changes — that is the point of a seam.
 */
import { randomUUID } from "node:crypto";
import { Queue, type ConnectionOptions } from "bullmq";
import type { Connection } from "mongoose";
import { createLogger } from "@medicore/logger";
import { env } from "../../config/env.js";
import { getTenantConnection } from "../db/connectionManager.js";
import { acquireLock, releaseLock, renewLock } from "../redis/redis.js";
import { listServable } from "../../modules/tenants/index.js";
import { claimDue, markRetryOrFail, markSent, type OutboxEventDoc } from "./outbox.js";
import { EVENT_QUEUE, NOTIFICATION_QUEUE, queuesFor } from "./eventCatalog.js";

const logger = createLogger({ service: "outbox-relay" });

const LOCK_NAME = "outbox-relay";
/** Long enough to survive a slow poll, short enough that a dead pod is replaced quickly. */
const LOCK_TTL_MS = 30_000;
/** A claim older than this belonged to a relay that is not coming back. */
const STALE_CLAIM_MS = 60_000;
/** Exponential-ish, capped: 1s → 5m (ADR-0007 retry policy). */
const BACKOFF_MS = [1_000, 10_000, 60_000, 180_000, 300_000];

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

/** One Queue object per target queue name, opened at start (see `queuesFor`). */
const queues = new Map<string, Queue>();
let timer: NodeJS.Timeout | undefined;
let running = false;
let stopped = false;
const holderId = randomUUID();

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 300_000;
}

/**
 * Puts one event on every queue that cares about it (`queuesFor`).
 *
 * ALL enqueues must succeed before the event is marked sent. If the second one
 * fails, the whole event is retried — which redelivers to the first queue too, and
 * is exactly why consumers dedupe (at-least-once, by design). The alternative,
 * marking sent after a partial fan-out, would silently drop the notification while
 * the analytics copy sailed through: a lost message that leaves no trace anywhere.
 */
async function dispatch(conn: Connection, event: OutboxEventDoc): Promise<void> {
  const envelope = {
    eventId: event.eventId,
    name: event.name,
    version: event.version,
    tenantId: event.tenantId,
    branchId: event.branchId,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    traceId: event.traceId,
    payload: event.payload,
  };

  for (const name of queuesFor(event.name)) {
    const target = queues.get(name);
    if (!target) throw new Error(`relay queue "${name}" not initialized`);

    await target.add(event.name, envelope, {
      // The consumer-side dedupe key. BullMQ refuses a duplicate jobId, which
      // collapses most redeliveries before a handler ever runs — belt to the
      // consumers' idempotency braces, not a replacement for it (a completed job
      // is eventually removed, after which the same id can be added again).
      // Job ids are per-queue, so the same event may sit in two queues at once —
      // which is the intent: two different concerns, two independent deliveries.
      jobId: event.eventId,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: false, // the DLQ: a failed job stays visible until an operator looks
    });
  }

  await markSent(conn, event._id);
}

/** Drains one hospital. Returns how many events it moved. */
async function relayTenant(tenant: {
  id: string;
  databaseName: string;
  dbUri?: string;
  slug: string;
}): Promise<number> {
  const conn = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  const events = await claimDue(conn, tenant.id, env.OUTBOX_BATCH_SIZE, STALE_CLAIM_MS);
  let sent = 0;

  for (const event of events) {
    try {
      await dispatch(conn, event);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await markRetryOrFail(
        conn,
        event,
        message,
        env.OUTBOX_MAX_ATTEMPTS,
        backoffFor(event.attempts),
      );

      if (outcome === "failed") {
        // Silent DLQ growth is an incident (ADR-0007). This is the alert surface
        // until the observability stack lands.
        logger.error(
          { tenant: tenant.slug, event: event.name, eventId: event.eventId, err: message },
          "outbox event exhausted its retries — moved to failed; operator action required",
        );
      } else {
        logger.warn(
          { tenant: tenant.slug, event: event.name, attempts: event.attempts, err: message },
          "outbox dispatch failed — will retry",
        );
      }
    }
  }

  return sent;
}

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;

  try {
    // Leadership, re-checked every tick: a pod that lost the lock (paused, slow,
    // restarted) must stop relaying rather than assume it is still the leader.
    const leader =
      (await renewLock(LOCK_NAME, LOCK_TTL_MS, holderId)) ||
      (await acquireLock(LOCK_NAME, LOCK_TTL_MS, holderId));

    if (!leader) return;

    const tenants = await listServable();
    let total = 0;
    for (const tenant of tenants) {
      total += await relayTenant(tenant);
    }

    if (total > 0) {
      logger.info({ events: total, tenants: tenants.length }, "outbox relayed");
    }
  } catch (err) {
    // The loop must never die: an exception here would silently stop event
    // delivery for the whole platform, and nothing would notice until a consumer
    // was found to be hours behind.
    logger.error({ err }, "outbox relay tick failed — continuing");
  } finally {
    running = false;
  }
}

export function startOutboxRelay(): void {
  if (!env.OUTBOX_RELAY_ENABLED) {
    logger.info("outbox relay disabled (OUTBOX_RELAY_ENABLED=false)");
    return;
  }
  if (!env.REDIS_URL) {
    logger.warn("outbox relay not started — REDIS_URL is not set; events will accumulate unsent");
    return;
  }

  const connection = redisConnection(env.REDIS_URL);
  for (const name of [EVENT_QUEUE, NOTIFICATION_QUEUE]) {
    queues.set(name, new Queue(name, { connection }));
  }

  stopped = false;
  timer = setInterval(() => void tick(), env.OUTBOX_POLL_MS);
  // Do not hold the process open for a poll: shutdown drains HTTP, not this.
  timer.unref();

  logger.info(
    { pollMs: env.OUTBOX_POLL_MS, batch: env.OUTBOX_BATCH_SIZE, queues: [...queues.keys()] },
    "outbox relay started",
  );
}

export async function stopOutboxRelay(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  await releaseLock(LOCK_NAME, holderId);
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
