/**
 * BullMQ worker service (Doc 04 §2.6, ADR-0007).
 * Sprint 0 ships ONE queue — `system` — with a repeatable heartbeat job that
 * proves the queue infrastructure end-to-end (enqueue → process → metricable).
 * Business queues (notifications, reports, …) land in their phases and MUST be
 * registered in docs/SCHEDULER_CATALOG.md (Guidelines §4).
 *
 * A minimal HTTP health server runs on HEALTH_PORT for Docker/K8s probes —
 * workers have no Express app, so probes need their own listener.
 */
import { createServer } from "node:http";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { createLogger } from "@medicore/logger";

const logger = createLogger({ service: "workers" });

const REDIS_URL = process.env.REDIS_URL;
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 4100);
const SYSTEM_QUEUE = "system";
/** Fed by the API's outbox relay (apps/api/src/core/events/outboxRelay.ts). */
const EVENT_QUEUE = "events";

let queue: Queue | undefined;
let worker: Worker | undefined;
let eventWorker: Worker | undefined;
let lastHeartbeatAt: string | undefined;
let eventsProcessed = 0;

/** The envelope the relay puts on the wire (EVENT_CATALOG global rules). */
interface DomainEventJob {
  eventId: string;
  name: string;
  version: number;
  tenantId: string;
  traceId?: string;
  actorId?: string;
  payload: Record<string, unknown>;
}

/**
 * The consumer end of the transactional outbox.
 *
 * Today it does nothing but acknowledge — there are no consumers yet, because
 * notifications (A6) has not been built. That is not a placeholder for its own
 * sake: it closes the loop, so the outbox is exercised end to end (publish →
 * commit → relay → queue → handler) on every login and every staff account
 * created, rather than being a mechanism we *believe* works and first discover to
 * be broken on the day a patient's discharge summary depends on it.
 *
 * When a real consumer arrives it registers here and MUST dedupe on `eventId`:
 * delivery is at-least-once by design (see outboxRelay.ts).
 */
async function handleDomainEvent(event: DomainEventJob): Promise<void> {
  eventsProcessed++;
  logger.info(
    {
      event: event.name,
      eventId: event.eventId,
      tenantId: event.tenantId,
      traceId: event.traceId,
    },
    "domain event received (no consumer registered yet — acknowledged)",
  );
}

/** BullMQ manages its own ioredis connections from options (avoids dual ioredis type identities). */
function redisConnection(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname.length > 1 ? { db: Number(parsed.pathname.slice(1)) } : {}),
    maxRetriesPerRequest: null, // BullMQ requirement
  };
}

async function start(): Promise<void> {
  if (!REDIS_URL) {
    logger.warn("REDIS_URL not set — running health-only mode (no queues)");
    return;
  }
  const connection = redisConnection(REDIS_URL);

  queue = new Queue(SYSTEM_QUEUE, { connection });
  worker = new Worker(
    SYSTEM_QUEUE,
    async (job) => {
      // Handlers must be idempotent (ADR-0007) — heartbeat trivially is.
      if (job.name === "heartbeat") {
        lastHeartbeatAt = new Date().toISOString();
        logger.debug({ jobId: job.id }, "heartbeat processed");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "job failed");
  });

  eventWorker = new Worker(
    EVENT_QUEUE,
    async (job) => {
      await handleDomainEvent(job.data as DomainEventJob);
    },
    { connection, concurrency: 5 },
  );

  eventWorker.on("failed", (job, err) => {
    // A job that exhausts its retries stays in the failed set (the DLQ) — it is
    // NOT removed. Silent DLQ growth is an incident (ADR-0007), and an event that
    // vanished because nobody was watching is the failure mode this whole pattern
    // exists to prevent.
    logger.error(
      { jobId: job?.id, event: job?.name, attempts: job?.attemptsMade, err },
      "domain event handler failed",
    );
  });

  await queue.upsertJobScheduler("system-heartbeat", { every: 60_000 }, { name: "heartbeat" });
  logger.info(
    { queues: [SYSTEM_QUEUE, EVENT_QUEUE] },
    "worker started; heartbeat every 60s; consuming domain events",
  );
}

const healthServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          status: "ok",
          service: "workers",
          queueActive: Boolean(worker),
          eventsActive: Boolean(eventWorker),
          eventsProcessed,
          lastHeartbeatAt: lastHeartbeatAt ?? null,
        },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

healthServer.listen(HEALTH_PORT, () => {
  logger.info({ port: HEALTH_PORT }, "workers health endpoint listening");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated — finishing in-flight jobs");
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  await Promise.allSettled([worker?.close(), eventWorker?.close(), queue?.close()]);
  healthServer.close(() => {
    clearTimeout(forceExit);
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

void start().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
