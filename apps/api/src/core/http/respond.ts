/**
 * The success half of the response envelope (Doc 04 §5.1).
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT THIRTY-NINE ────────────────────────────
 * Every controller declared its own `ok()`. They were not quite the same function: four distinct
 * signatures had grown, and one of them took `meta` in the THIRD position where the other thirty-
 * eight took an HTTP status. Nothing caught it, because each copy was locally consistent — the
 * mismatch only existed between files, which is exactly where nothing was looking.
 *
 * That is the real cost of a copied helper: not the duplication, but that the copies diverge in
 * ways no single file can be wrong about. A response envelope is the one shape every client on
 * every platform depends on, so it gets one definition.
 *
 * The errors half already worked this way — `errorHandler.ts` is the only place an error envelope
 * is produced, which is why `{ error: { code, message, details?, traceId } }` never drifted.
 */
import type { Response } from "express";
import type { ApiEnvelope, PageMeta } from "@medicore/types";
import { env } from "../../config/env.js";
import type { ResponseTag } from "./routeInventory.js";

/**
 * Sends `{ success: true, data }`, plus `meta` for a paginated list.
 *
 * `status` before `meta` because the overwhelming majority of call sites pass a status (201 on a
 * create) and never a meta — and because it preserves the signature 38 of the 39 copies already
 * had, so migrating them is a deletion rather than a rewrite.
 */
export function ok<T>(res: Response, data: T, status = 200, meta?: PageMeta): void {
  const body: ApiEnvelope<T> = { success: true, data, ...(meta ? { meta } : {}) };
  verifyContract(res, data, status);
  res.status(status).json(body);
}

/**
 * ── THE CONTRACT, CHECKED AGAINST THE THING ACTUALLY SENT ───────────────────
 * `responds()` leaves the route's declared response schema here; this parses the payload against
 * it before it goes out. Every integration test becomes a contract test as a side effect, which
 * is the only way to catch the mismatches a type cannot see — a controller that sends
 * `{ order }` where the schema says `Order`, a repository that stops populating a field, a
 * service that returns `null` on a path the schema calls required.
 *
 * The payload is round-tripped through JSON first, deliberately: the schema describes the WIRE
 * shape, where a `Date` is an ISO string. Validating the in-memory object instead would fail on
 * every timestamp and would be checking something no client ever sees.
 *
 * Off in production — a hospital must not lose a response because a schema is out of date, and by
 * then the check has run against every test in the suite.
 */
const VERIFY = env.NODE_ENV !== "production";

function verifyContract(res: Response, data: unknown, status: number): void {
  if (!VERIFY) return;
  const tag = (res.locals as Record<string, unknown>)["responseContract"] as
    ResponseTag | undefined;
  if (!tag?.schema) return;

  if (!tag.statuses.includes(status)) {
    throw new Error(
      `response contract: this route sent ${String(status)} but declares ` +
        `${tag.statuses.join(", ")} — update responds() or the controller`,
    );
  }

  // `JSON.stringify(undefined)` is not a string, so it cannot be round-tripped. An absent `data`
  // is a real wire shape here (one route returns nothing when there was nothing to set), and the
  // schema says so with `.optional()`.
  const wire = data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as unknown);
  const result = tag.schema.safeParse(wire);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `response contract violated — the payload is not the shape this route documents. ${issues}`,
    );
  }
}
