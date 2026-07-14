/**
 * Request logging (Doc 09 §8: "method, path, status, duration, tenant").
 *
 * WHY THIS WAS MISSING AND WHY THAT HURT
 * --------------------------------------
 * The API had no access log at all. When a browser could not reach it, there was
 * no way to answer the first question any diagnosis needs — *did the request even
 * arrive?* — and without that, the whole space stays open: DNS, address family,
 * CORS, the client, the server. Half of a two-hour debugging session was spent
 * not knowing which half of the wire to look at.
 *
 * So: one line per request, including the OPTIONS preflights that a browser sends
 * and a curl does not. If a request appears here, the network reached us and the
 * problem is above; if it does not, the problem is below and nothing in the
 * application code can be the cause.
 *
 * No bodies at info level (Doc 09 §8) — a login body contains a password, and an
 * access log is shipped, indexed and retained.
 */
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "@medicore/logger";
import { tryGetContext } from "../context/requestContext.js";

export function requestLog(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      // Health probes every few seconds would drown the log they are meant to
      // sit beside. They are still logged when they FAIL, because that matters.
      if ((req.path === "/health" || req.path === "/ready") && res.statusCode < 400) return;

      const ctx = tryGetContext();

      logger.info(
        {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          // The tenant this resolved to — or nothing, which is itself the answer
          // when a request fails with HMS-TEN-001.
          ...(ctx?.tenantSlug ? { tenant: ctx.tenantSlug } : {}),
          ...(ctx?.userId ? { userId: ctx.userId } : {}),
          // The browser's origin, because a cross-origin failure is invisible
          // without it — and it is the header curl does not send by default,
          // which is exactly why curl kept succeeding where the browser failed.
          ...(req.headers.origin ? { origin: req.headers.origin } : {}),
          traceId: req.traceId,
        },
        `${req.method} ${req.originalUrl} ${String(res.statusCode)}`,
      );
    });

    next();
  };
}
