/**
 * `Deprecation` / `Sunset` — how an endpoint is retired without breaking a phone (Doc 04 §5.1).
 *
 *     router.get(
 *       "/patients/:id/summary",
 *       authenticate(),
 *       authorize(PERMISSIONS.PATIENT_READ),
 *       deprecate({
 *         since: "2026-09-01",
 *         sunset: "2027-09-01",
 *         replacedBy: "/api/v1/encounters?patientId=",
 *         note: "The visit list carries the same fields plus the branch.",
 *       }),
 *       asyncHandler(controller.summary),
 *     );
 *
 * ── NOTHING IS DEPRECATED TODAY, AND THAT IS ASSERTED ───────────────────────
 * This file is machinery, not a policy applied to anything. No route calls it, and
 * `deprecation.test.ts` fails if one ever does without a deliberate change to that test. The
 * reason is that these headers are read by machines: a client that sees `Sunset` may log a
 * warning, raise an alert, or refuse to build against the endpoint. Marking something deprecated
 * "to show the feature works" spends a signal that only means anything while it is rare.
 *
 * ── WHY A MIDDLEWARE AND NOT A FLAG IN THE SPEC ─────────────────────────────
 * A `deprecated: true` written by hand into an OpenAPI file tells a code generator and nobody
 * else. The caller who matters is the one already in the field — a mobile build that shipped
 * eighteen months ago and cannot be patched — and it learns nothing from a document it never
 * fetches. It has to be told in the response to the call it is actually making.
 *
 * So the declaration lives in the route chain, the headers go out on every response, and the
 * OpenAPI flag is READ BACK from the same declaration. One source, two audiences.
 *
 * ── THE TWELVE-MONTH WINDOW IS ENFORCED, NOT SUGGESTED ──────────────────────
 * Doc 04 §5.1 promises a minimum twelve-month sunset window. A promise written only in prose is
 * one someone shortens under delivery pressure, in the release where it matters most. `deprecate()`
 * throws at startup if the window is shorter, so the shortcut is not available.
 *
 * ── THE HEADERS ─────────────────────────────────────────────────────────────
 * `Deprecation: @<unix-seconds>`  — RFC 9745, a structured-field Item.
 * `Sunset: <HTTP-date>`           — RFC 8594.
 * `Link: <…>; rel="deprecation"`  — where to read about it (RFC 9745 §3).
 * `Link: <…>; rel="successor-version"` — what to call instead, when there is one (RFC 8594 §3).
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { tagDeprecation, type DeprecationTag } from "../core/http/routeInventory.js";

/** Doc 04 §5.1 — "deprecated endpoints … with a 12-month minimum sunset window". */
export const MIN_SUNSET_WINDOW_DAYS = 365;

/** Where a deprecation is explained. One page; each entry is anchored by date. */
export const DEPRECATION_DOC_URL = "https://docs.paperlesstech.in/api/deprecations";

export interface DeprecateOptions {
  /** `YYYY-MM-DD` — the day this operation became deprecated. May be in the past. */
  since: string;
  /** `YYYY-MM-DD` — the day it stops answering. At least a year after `since`. */
  sunset: string;
  /** The path or operation that replaces it, if there is one. */
  replacedBy?: string;
  /** One sentence for the spec and the changelog: what a caller should do. */
  note?: string;
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`deprecate(): ${field} must be YYYY-MM-DD, received "${value}"`);
  }
  const at = new Date(`${value}T00:00:00.000Z`);
  /**
   * The round-trip is the check, because `new Date` does not fail on an impossible day — it ROLLS
   * OVER. `2026-02-30` becomes 2 March and nothing complains, so a sunset date would quietly move
   * by two days and the only place it would ever show up is a client's calendar.
   */
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) {
    throw new Error(`deprecate(): ${field} is not a real date — "${value}"`);
  }
  return at;
}

export function deprecate(options: DeprecateOptions): RequestHandler {
  const since = parseDay(options.since, "since");
  const sunset = parseDay(options.sunset, "sunset");

  const windowDays = (sunset.getTime() - since.getTime()) / 86_400_000;
  if (windowDays < MIN_SUNSET_WINDOW_DAYS) {
    /**
     * Thrown while the router is being BUILT, so the server does not start. A validation that
     * only fires on a request would let a too-short window ship and be discovered by the client
     * it hurt — which is the whole population this rule exists to protect.
     */
    throw new Error(
      `deprecate(): the sunset window must be at least ${String(MIN_SUNSET_WINDOW_DAYS)} days ` +
        `(Doc 04 §5.1); ${options.since} → ${options.sunset} is ${String(Math.floor(windowDays))}`,
    );
  }

  const tag: DeprecationTag = {
    since: options.since,
    sunset: options.sunset,
    ...(options.replacedBy ? { replacedBy: options.replacedBy } : {}),
    ...(options.note ? { note: options.note } : {}),
  };

  // Built once, not per request: these strings never vary, and a header assembled on every call
  // is work done a million times to produce the same twelve bytes.
  const deprecationHeader = `@${String(Math.floor(since.getTime() / 1000))}`;
  const sunsetHeader = sunset.toUTCString();
  const links = [`<${DEPRECATION_DOC_URL}>; rel="deprecation"`];
  if (options.replacedBy) links.push(`<${options.replacedBy}>; rel="successor-version"`);
  const linkHeader = links.join(", ");

  const handler = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Deprecation", deprecationHeader);
    res.setHeader("Sunset", sunsetHeader);
    /**
     * Appended rather than assigned. `Link` is a list, and another middleware may legitimately
     * add its own relation (pagination, for one). Overwriting would silently delete it.
     */
    const existing = res.getHeader("Link");
    res.setHeader("Link", existing ? `${String(existing)}, ${linkHeader}` : linkHeader);
    next();
  };

  return tagDeprecation(handler, tag);
}
