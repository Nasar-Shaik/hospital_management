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

/**
 * Did the SERVER refuse this because the hospital's edition does not include the module?
 *
 * ── WHY A SEPARATE PREDICATE, AND NOT JUST "IT FAILED" ──────────────────────
 * `HMS-PLAN-002` and `HMS-AUTH-005` are both 403s and mean opposite things to the person reading
 * the screen. "You lack permission" is fixable by an administrator at this hospital. "Not in your
 * edition" is not fixable by anyone here, at all, ever — no amount of role editing will help, and
 * the remedy is a conversation with an account manager.
 *
 * The distinction matters because of how the pages behaved without it. `/emergency` printed the
 * refusal and then, directly beneath it, "Nobody in the emergency department."; `/theatres`
 * offered "Book a procedure" and reported "No theatres yet." A refusal rendered as EMPTINESS reads
 * as "this hospital has none of these yet" — which is a lie about the product, and it is what sent
 * a clinic administrator hunting through the role editor (D20).
 *
 * The mobile app has had exactly this predicate, under exactly this name, since M0 — see
 * `apps/mobile/src/lib/net/errors.ts`. This is the same rule reaching the other client.
 */
export function isFeatureUnavailable(err: unknown): boolean {
  return err instanceof ApiClientError && err.code === "HMS-PLAN-002";
}
