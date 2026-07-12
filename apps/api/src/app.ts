/**
 * Express app assembly (Doc 04 §2.1 middleware order).
 * Sprint 0 chain: requestId → helmet/cors → bodyParse → routes → 404 → error.
 * P1 inserts: resolveTenant → authenticate → authorize → validate → idempotency.
 * Business modules mount under src/modules/<name>/ per Doc 09 §1 — none yet.
 */
import express, { type Express, Router } from "express";
import helmet from "helmet";
import cors from "cors";
import type { Logger } from "@medicore/logger";
import { requestId } from "./core/http/requestId.js";
import { errorHandler, notFoundHandler } from "./core/http/errorHandler.js";
import { healthRouter } from "./core/health/health.router.js";
import { resolveTenant } from "./middleware/resolveTenant.js";
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

  // Health/readiness run BEFORE tenant resolution — probes have no tenant host
  // and liveness must never depend on the registry (Doc 04 §8).
  app.use(healthRouter);

  /**
   * Tenant-scoped API surface (Doc 04 §2.1 chain, §5.1).
   * Every request under /api/v1 is resolved to exactly one hospital database
   * before any handler runs. Phase 1B inserts authenticate → authorize →
   * validate → idempotency after resolveTenant; business module routers mount
   * on v1Router from Phase 2.
   */
  const v1Router = Router();
  app.use("/api/v1", resolveTenant(), v1Router);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
