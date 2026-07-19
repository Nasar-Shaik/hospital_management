/**
 * Turning a thrown thing into something we can SHOW and something we can TRACE.
 *
 * Every API error carries a stable `code` (HMS-XXX-NNN) and a `traceId` that is also stamped on the
 * server log line for that exact request. Surfacing them next to the message is what lets a user say
 * "it failed, reference HMS-STATE-001 · a1b2c3d4" and have us find the one log line that explains it —
 * instead of "it didn't work" and a hunt. The message stays human; the reference is the thread back
 * to the cause.
 */
import { ApiClientError } from "@medicore/api-client";

export interface DescribedError {
  /** The human-readable line to show the user. */
  message: string;
  /** `CODE · traceId` — the reference that maps to the server log, when the error carries one. */
  reference?: string;
}

/**
 * Describes any thrown value for display. Prefers a field-level validation message (it says exactly
 * what to fix), falls back to the error's own message, then to the caller's `fallback`. A plain
 * string is treated as an already-formed message. Non-API errors (a dropped network, a bug) get the
 * fallback — they have no code to show, but the console/log still has the stack.
 */
export function describeError(err: unknown, fallback = "Something went wrong."): DescribedError {
  if (err instanceof ApiClientError) {
    const field = Object.values(err.fieldErrors)[0]?.[0];
    const reference = [err.code, err.traceId].filter(Boolean).join(" · ");
    return {
      message: field ?? err.message ?? fallback,
      ...(reference ? { reference } : {}),
    };
  }
  if (typeof err === "string" && err.trim()) return { message: err };
  return { message: fallback };
}
