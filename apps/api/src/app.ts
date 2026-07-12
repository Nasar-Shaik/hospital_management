/**
 * Express app assembly (Doc 04 §2.1 middleware order).
 * Sprint 0 chain: requestId → helmet/cors → bodyParse → routes → 404 → error.
 * P1 inserts: resolveTenant → authenticate → authorize → validate → idempotency.
 * Business modules mount under src/modules/<name>/ per Doc 09 §1 — none yet.
 */
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import type { Logger } from "@medicore/logger";
import { requestId } from "./core/http/requestId.js";
import { errorHandler, notFoundHandler } from "./core/http/errorHandler.js";
import { healthRouter } from "./core/health/health.router.js";
import { env } from "./config/env.js";

export function createApp(logger: Logger): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true); // behind Nginx/Traefik gateway (Doc 04 §2.1)

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);

  // /api/v1 business routes mount here from P1 (Doc 04 §5.1).

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
