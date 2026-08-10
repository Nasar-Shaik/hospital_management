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
 *
 * ── AND NO URLs EITHER, WHICH IS LESS OBVIOUS ───────────────────────────────
 * "No bodies" was honoured and still leaked PHI, because this line logged
 * `req.originalUrl` — which carries the QUERY STRING. `GET /api/v1/patients?q=…`
 * searches name, phone and UHID (`patient.repository.ts`), so every patient
 * lookup wrote the searched name or phone number into the access log at info
 * level. Constitution §3.2 forbids PHI "in logs, error messages, URLs" — the URL
 * clause is there for exactly this, and it was the one being broken.
 *
 * So the line now logs the ROUTE TEMPLATE (`/api/v1/patients/by-uhid/:uhid`)
 * rather than the URL that was called. That is strictly better than redacting:
 * there is no PHI to leak because the values were never in it, and a template is
 * what you want for grouping and rate metrics anyway (a per-patient URL is
 * unbounded cardinality). The raw path is used only when nothing matched — a 404
 * has no template — and is scrubbed of anything identifier-shaped first.
 */
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "@medicore/logger";
import { tryGetContext } from "../context/requestContext.js";

/**
 * Path segments that look like a person rather than a route.
 *
 * Only reached on unmatched requests. Mongo ObjectIds are deliberately left alone:
 * they are opaque without the database, and they are the handle support uses to
 * follow one request through the logs.
 */
const OBJECT_ID = /^[a-f\d]{24}$/i;

function scrubSegment(segment: string): string {
  if (segment.length === 0 || OBJECT_ID.test(segment)) return segment;
  // A UHID, an ABHA number, a phone number, a long digit run — anything that
  // identifies a person rather than naming a resource.
  if (/\d{4,}/.test(segment)) return ":redacted";
  return segment;
}

/** The matched route template, or a scrubbed path when nothing matched (404s, early refusals). */
function routeOf(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route;
  if (route?.path) {
    const base = req.baseUrl || "";
    return `${base}${route.path === "/" ? "" : route.path}` || "/";
  }
  return req.path.split("/").map(scrubSegment).join("/");
}

export function requestLog(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      // Health probes every few seconds would drown the log they are meant to
      // sit beside. They are still logged when they FAIL, because that matters.
      if ((req.path === "/health" || req.path === "/ready") && res.statusCode < 400) return;

      const ctx = tryGetContext();
      const route = routeOf(req);

      logger.info(
        {
          method: req.method,
          // The template, never the called URL — see the header. Kept under `path` so
          // existing log queries and dashboards keep working.
          path: route,
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
        // The template here too. The sanitiser cannot help with `msg` — it is a
        // formatted string, not a field — so the URL must not be put into it.
        `${req.method} ${route} ${String(res.statusCode)}`,
      );
    });

    next();
  };
}
