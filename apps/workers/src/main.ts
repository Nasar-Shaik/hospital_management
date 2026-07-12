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

let queue: Queue | undefined;
let worker: Worker | undefined;
let lastHeartbeatAt: string | undefined;

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

  await queue.upsertJobScheduler("system-heartbeat", { every: 60_000 }, { name: "heartbeat" });
  logger.info({ queue: SYSTEM_QUEUE }, "worker started; heartbeat scheduled every 60s");
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
  await Promise.allSettled([worker?.close(), queue?.close()]);
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
