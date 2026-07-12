/**
 * Bootstrap + graceful shutdown (Doc 04 §2.3):
 * stop accepting → drain HTTP → close deps → exit.
 */
import { createLogger } from "@medicore/logger";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closeMaster } from "./core/db/masterDb.js";
import { closeAllTenantConnections } from "./core/db/connectionManager.js";
import { closeRedis } from "./core/redis/redis.js";

const logger = createLogger({ service: "api", level: env.LOG_LEVEL });
const app = createApp(logger);

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, "api listening");
});

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
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
    clearTimeout(forceExit);
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
