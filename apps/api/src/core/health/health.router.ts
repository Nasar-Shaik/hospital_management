/**
 * Liveness + readiness endpoints (Doc 04 §8, Doc 05 §5 reliability checklist).
 * /health  → process is alive (no dependency checks — liveness must not flap).
 * /ready   → dependencies reachable; 503 when a configured dependency is down
 *            so orchestrators gate traffic. Unconfigured deps report "skipped"
 *            (Sprint 0 allows running without infra; P1 tightens).
 */
import { Router, type Request, type Response } from "express";
import type { ApiEnvelope, HealthStatus, ReadinessStatus } from "@medicore/types";
import { pingMaster } from "../db/masterDb.js";
import { pingRedis } from "../redis/redis.js";
import { env } from "../../config/env.js";

const startedAt = Date.now();
export const SERVICE_NAME = "api";
export const SERVICE_VERSION = process.env.npm_package_version ?? "0.0.1";

export const healthRouter: Router = Router();

healthRouter.get("/health", (_req: Request, res: Response) => {
  const body: ApiEnvelope<HealthStatus> = {
    success: true,
    data: {
      status: "ok",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    },
  };
  res.json(body);
});

healthRouter.get("/ready", async (_req: Request, res: Response) => {
  const checks: ReadinessStatus["checks"] = {
    mongo: env.MONGO_URI ? await pingMaster() : "skipped",
    redis: env.REDIS_URL ? await pingRedis() : "skipped",
  };
  const down = Object.values(checks).includes("down");
  const body: ApiEnvelope<ReadinessStatus> = {
    success: !down,
    data: { status: down ? "degraded" : "ready", service: SERVICE_NAME, checks },
    ...(down ? { error: { code: "HMS-TEN-004", message: "A dependency is unavailable" } } : {}),
  };
  res.status(down ? 503 : 200).json(body);
});
