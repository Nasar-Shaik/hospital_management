/**
 * Retry policy — one predicate, applied by the query client, never by a screen.
 *
 * ── READS RETRY. MUTATIONS DO NOT. ──────────────────────────────────────────
 * A read is idempotent by definition, so re-issuing it costs a round trip. A mutation is not, and
 * the transport has no way to know whether the first attempt reached the server: a request that
 * timed out may have created the payment. Automatic retry there is how a phone charges twice.
 *
 * Retry of a mutation is therefore a USER action — a button they press, carrying the SAME
 * `Idempotency-Key`, which is the mechanism that makes the second attempt safe (M0 §11). The
 * transport must not do it silently, because a silent retry cannot reuse the key's intent
 * semantics in a way the user can see or cancel.
 */
import { ApiClientError } from "@medicore/api-client";

export const MAX_READ_RETRIES = 2;
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Status codes worth a second attempt. A 4xx will not become a 2xx by asking again — the request
 * is wrong, or the caller is not allowed — and retrying it just delays the error the user needs.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return true; // transport failure: the wire, not the API
  if (error.code === "HMS-REQ-001") return false; // rate limited — respect it, do not hammer
  return error.status >= 500;
}

export function shouldRetryRead(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_READ_RETRIES && isTransient(error);
}

/** Never. Present as a named export so the intent is visible where it is wired in. */
export function shouldRetryMutation(): boolean {
  return false;
}

/**
 * Exponential backoff with jitter. The jitter matters more than it looks: without it, a ward full
 * of phones that lost wifi together retry in lockstep and arrive as a spike the moment it returns.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1_000 * 2 ** attempt, 8_000);
  return Math.round(base * (0.5 + random() * 0.5));
}
