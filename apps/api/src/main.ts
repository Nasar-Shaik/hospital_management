/**
 * Bootstrap + graceful shutdown (Doc 04 §2.3):
 * stop accepting → drain HTTP → close deps → exit.
 */
import { createLogger } from "@medicore/logger";
import { createApp } from "./app.js";
import { bindAddress, describeConfig, env } from "./config/env.js";
import { closeMaster } from "./core/db/masterDb.js";
import { closeAllTenantConnections } from "./core/db/connectionManager.js";
import { closeRedis } from "./core/redis/redis.js";
import { startOutboxRelay, stopOutboxRelay } from "./core/events/outboxRelay.js";
import { startEventConsumer, stopEventConsumer } from "./core/events/eventConsumer.js";
import { closeTaskQueue } from "./core/events/taskQueue.js";

const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const app = createApp(logger);

// In production this binds to loopback: the API is reachable only through the
// gateway, so a misconfigured firewall cannot expose Express to the internet.
// In dev it is undefined — Node then listens dual-stack (`::` + IPv4-mapped),
// which is required because `<slug>.localhost` resolves to ::1 first. See
// `bindAddress()` for the bug this prevents.
const bind = bindAddress();

const onListening = (): void => {
  // The effective config, not the intended one. Every configuration bug we have
  // hit was invisible at boot — the process looked healthy and was quietly aimed
  // at the wrong thing. One line here turns that into a glance. Never a secret:
  // `describeConfig` reports a key's presence, never its value.
  logger.info({ port: env.PORT, ...describeConfig() }, "api listening");
};

const server = bind ? app.listen(env.PORT, bind, onListening) : app.listen(env.PORT, onListening);

// Every pod starts the relay; a Redis lock elects one leader (ADR-0007). Nothing
// is lost if no leader exists for a while — events wait, durably, in the outbox.
startOutboxRelay();

// EVERY pod consumes, though — no lock. Unlike the relay (which reads every
// tenant's outbox and would duplicate work), consumers pull from a shared queue:
// BullMQ hands each job to exactly one of them, so more pods is more throughput
// rather than more copies of the same email.
startEventConsumer();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated");

  const forceExit = setTimeout(() => {
    logger.error("shutdown drain timed out — forcing exit");
    process.exit(1);
  }, 30_000);

  server.close(async () => {
    // The relay stops BEFORE the connections it uses are closed — a mid-poll
    // shutdown would otherwise log a wall of "connection closed" errors that look
    // like an incident and are really just a deploy. Events it did not get to stay
    // `pending` and the next leader picks them up.
    // The consumer stops before its database does. A job killed mid-flight is not
    // lost — BullMQ returns it to the queue and another pod takes it, and the
    // dedupe key means the patient is not told twice.
    await Promise.allSettled([stopOutboxRelay(), stopEventConsumer(), closeTaskQueue()]);
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
    clearTimeout(forceExit);
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
