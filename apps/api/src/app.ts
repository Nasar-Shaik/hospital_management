/**
 * Express app assembly (Doc 04 §2.1 middleware order).
 * Sprint 0 chain: requestId → helmet/cors → bodyParse → routes → 404 → error.
 * P1 inserts: resolveTenant → authenticate → authorize → validate → idempotency.
 * Business modules mount under src/modules/<name>/ per Doc 09 §1 — none yet.
 */
import express, { type Express, Router } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import type { Logger } from "@medicore/logger";
import { requestId } from "./core/http/requestId.js";
import { requestLog } from "./core/http/requestLog.js";
import { errorHandler, notFoundHandler } from "./core/http/errorHandler.js";
import { healthRouter } from "./core/health/health.router.js";
import { resolveTenant } from "./middleware/resolveTenant.js";
import { auditRouter } from "./modules/audit/index.js";
import { platformRouter } from "./modules/platform/index.js";
import { authRouter } from "./modules/auth/index.js";
import { rbacRouter } from "./modules/rbac/rbac.routes.js";
import { staffRouter } from "./modules/staff/index.js";
import { subscriptionRouter } from "./modules/subscriptions/index.js";
import { patientRouter } from "./modules/patients/index.js";
import { encounterRouter } from "./modules/encounters/index.js";
import { orderRouter } from "./modules/orders/index.js";
import { billingRouter } from "./modules/billing/index.js";
import { prescriptionRouter } from "./modules/prescriptions/index.js";
import { pharmacyRouter } from "./modules/pharmacy/index.js";
import { medicineRouter } from "./modules/medicines/index.js";
import { admissionRouter } from "./modules/admissions/index.js";
import { allergyRouter } from "./modules/allergies/index.js";
import { reportRouter } from "./modules/reports/index.js";
import { appointmentRouter } from "./modules/appointments/index.js";
import { notificationRouter } from "./modules/notifications/index.js";
import { reportingRouter } from "./modules/reporting/index.js";
import { env } from "./config/env.js";

export function createApp(logger: Logger): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", true); // behind Nginx/Traefik gateway (Doc 04 §2.1)

  app.use(requestId);
  // Before helmet/cors: a request refused BY cors must still appear in the log,
  // or a CORS failure looks identical to a request that never arrived.
  app.use(requestLog(logger));
  app.use(helmet());
  app.use(
    cors({
      /**
       * Tenant-aware CORS.
       *
       * In PRODUCTION the web app and the API share a hostname (the gateway routes
       * `/api/*`), so requests are same-origin and CORS barely applies — only the
       * explicitly listed origins are honoured.
       *
       * In DEVELOPMENT they differ by PORT, which makes them different origins, so
       * the browser demands CORS. And the origin is per-hospital by nature
       * (`apollo.localhost:3000`, `demo.localhost:3000`), so a fixed allowlist
       * cannot work — a new tenant would be locked out of its own login page. We
       * therefore reflect any origin under the tenant base domain.
       *
       * This is a dev-only relaxation, gated on NODE_ENV, and it grants nothing:
       * every request still has to pass tenant resolution, authentication and
       * authorization. CORS decides who may *ask*, never who may *have*.
       */
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // curl, server-to-server, same-origin

        const allowlist = env.CORS_ORIGINS.split(",").map((o) => o.trim());
        if (allowlist.includes(origin)) return callback(null, true);

        if (env.NODE_ENV !== "production") {
          try {
            const { hostname } = new URL(origin);
            const base = env.TENANT_BASE_DOMAIN;
            if (hostname === base || hostname.endsWith(`.${base}`)) {
              return callback(null, true);
            }
          } catch {
            /* malformed Origin — fall through to refusal */
          }
        }

        return callback(null, false);
      },
      credentials: true,
    }),
  );
  /**
   * 1 MB is the right ceiling for every ordinary JSON request, and a low ceiling is a cheap
   * defence against a memory-exhaustion body. The ONE exception is a report upload, which
   * carries a base64 file: its route mounts its OWN higher-limit parser, so this global one
   * must step aside for that path — otherwise it rejects the upload at 1 MB before the route's
   * parser is ever reached. Matched narrowly (POST …/orders/:id/reports) so nothing else is
   * granted the larger body.
   */
  const globalJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.method === "POST" && /\/orders\/[a-f\d]{24}\/reports$/i.test(req.path)) {
      return next();
    }
    return globalJson(req, res, next);
  });
  // Browsers carry the refresh token in an httpOnly cookie (ADR-0009); native
  // clients send it in the body. Both paths need this parsed.
  app.use(cookieParser());

  // Health/readiness run BEFORE tenant resolution — probes have no tenant host
  // and liveness must never depend on the registry (Doc 04 §8).
  app.use(healthRouter);

  /**
   * Tenant-scoped API surface (Doc 04 §2.1 chain, §5.1).
   *
   * Every request under /api/v1 is resolved to exactly one hospital database
   * before any handler runs — including /auth/login, which is why you cannot log
   * in without naming a hospital.
   *
   * `authenticate` is applied per-route rather than to the whole router, because
   * /auth/login and /auth/refresh must stay reachable without a token. Business
   * routers (Phase 2) mount the same way the RBAC router already does:
   *     authenticate() → authorize(PERMISSIONS.X, { feature }) → validate() → handler
   * Remaining chain slot: idempotency (P2, for money-moving POSTs).
   */
  /**
   * The CONTROL PLANE (Doc 02 A1) — mounted BEFORE the tenant router and outside
   * `resolveTenant`, because an operator's request names no hospital.
   *
   * This separation is structural, not stylistic: there is no tenant context on
   * these routes, so no service reached from here can accidentally pick up a
   * tenant connection. When the control plane must enter a hospital's data (to
   * count seats, to seed an administrator), it opens that connection explicitly
   * and narrowly. And an operator token is rejected by /api/v1 — it carries no
   * `tid`, so it can never match a host-resolved tenant.
   */
  app.use("/api/platform/v1", platformRouter());

  const v1Router = Router();
  v1Router.use("/auth", authRouter());
  v1Router.use(rbacRouter());
  v1Router.use(staffRouter());
  v1Router.use(subscriptionRouter());
  v1Router.use(auditRouter());
  // The first clinical module (P2). Everything above it is platform.
  v1Router.use(patientRouter());
  // Feature-gated: a hospital that never bought scheduling gets HMS-PLAN-002.
  v1Router.use(encounterRouter());
  v1Router.use(orderRouter());
  v1Router.use(billingRouter());
  v1Router.use(prescriptionRouter());
  v1Router.use(pharmacyRouter());
  v1Router.use(medicineRouter());
  v1Router.use(admissionRouter());
  v1Router.use(allergyRouter());
  v1Router.use(reportRouter());
  v1Router.use(appointmentRouter());
  v1Router.use(notificationRouter());
  v1Router.use(reportingRouter());
  app.use("/api/v1", resolveTenant(), v1Router);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
