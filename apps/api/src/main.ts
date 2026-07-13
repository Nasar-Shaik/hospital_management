/**
 * Bootstrap + graceful shutdown (Doc 04 §2.3):
 * stop accepting → drain HTTP → close deps → exit.
 */
import { createLogger } from "@medicore/logger";
import { createApp } from "./app.js";
import { bindAddress, env } from "./config/env.js";
import { closeMaster } from "./core/db/masterDb.js";
import { closeAllTenantConnections } from "./core/db/connectionManager.js";
import { closeRedis } from "./core/redis/redis.js";
import { startOutboxRelay, stopOutboxRelay } from "./core/events/outboxRelay.js";

const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const app = createApp(logger);

// In production this binds to loopback: the API is reachable only through the
// gateway, so a misconfigured firewall cannot expose Express to the internet.
const bind = bindAddress();

const server = app.listen(env.PORT, bind, () => {
  logger.info({ port: env.PORT, bind, nodeEnv: env.NODE_ENV }, "api listening");
});

// Every pod starts the relay; a Redis lock elects one leader (ADR-0007). Nothing
// is lost if no leader exists for a while — events wait, durably, in the outbox.
startOutboxRelay();

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
    await stopOutboxRelay();
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
    clearTimeout(forceExit);
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
