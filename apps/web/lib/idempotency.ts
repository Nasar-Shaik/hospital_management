/**
 * Idempotency keys for money-moving and critical requests (Doc 04 §5.1, `docs/IDEMPOTENCY.md`).
 *
 * ── WHY A HOOK AND NOT A KEY MINTED PER CALL ────────────────────────────────
 * A key generated inside the API client, on each call, protects nothing: a
 * double-click makes two calls, each would mint its own key, and the server would
 * see two unrelated payments. The key has to identify the user's INTENT — "this
 * payment, the one I am submitting now" — so it must be:
 *
 *   stable across every retry of the same submission  (double-click, a timeout the
 *   cashier retries, a request that actually succeeded but whose response was lost)
 *
 *   different for a genuinely new payment              (a second part-payment on the
 *   same bill is not a duplicate — it is more money, and it must go through)
 *
 * So it is minted once per payment FORM and renewed the moment a payment lands.
 * `busy` flags already stop the naive double-click; this is what covers the cases
 * they cannot see — a retry after an apparent failure that actually worked, and a
 * second tab.
 *
 * ── IT TRAVELS AS A HEADER NOW, NOT IN THE BODY ─────────────────────────────
 * These keys used to be passed as `body.requestId`, which only four endpoints understood and
 * each in its own way. The server now has ONE mechanism — the `Idempotency-Key` header — that
 * covers 24 operations, replays the original response byte for byte, and refuses a key reused
 * with a different payload instead of quietly replaying it.
 *
 * Where an endpoint also has a `requestId` field, callers pass the SAME string to both. The
 * header is the mechanism; the body field is the second lock, and it is the one that still holds
 * if a proxy ever strips an unfamiliar header. Cheap, and the failure it covers is money.
 */
import { useCallback, useRef, useState } from "react";
import { ApiClientError } from "@medicore/api-client";

/**
 * A single key, for callers that cannot use the hook — typically a per-row action in a list,
 * where the intent is identified by the row rather than by the component. Hold it against the
 * row while the request is in flight and drop it once the money has moved, so a RETRY reuses it
 * and a genuinely new action gets a fresh one.
 */
export function newIdempotencyKey(): string {
  return mint();
}

function mint(): string {
  // `randomUUID` needs a secure context; every browser we serve has one (the app is
  // HTTPS in production and localhost in dev, both of which qualify). The fallback
  // exists so a non-secure preview host degrades to a working key rather than
  // throwing inside a payment form.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Returns the current key and a `renew` to call after the money has moved.
 *
 *     const [payKey, renewPayKey] = useIdempotencyKey();
 *     await api.recordPayment(id, { amount, method, requestId: payKey }, payKey);
 *     renewPayKey();
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(mint);
  const renew = useCallback(() => {
    setKey(mint());
  }, []);
  return [key, renew];
}

/**
 * Keys for a screen whose intents are identified by a THING rather than by a form — a row in a
 * list, a line on a prescription, a test in a basket.
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
 * Two screens built their key as `` `ord-${encounterId}-${code}-${Date.now()}` ``. That reads as
 * a per-item key and is not one: `Date.now()` moves, so every click produced a NEW key and the
 * double-click it was written to stop went straight through as a second order. A key derived
 * from the clock protects nothing, and it looks exactly like a key that does.
 *
 * The opposite mistake is just as real: a key that is a pure function of `(encounter, drug)` and
 * never changes would refuse tomorrow's repeat blood sugar as a duplicate. A repeat two hours
 * later is medicine, not a mistake.
 *
 * So: minted on first use per id, HELD while the attempt is in flight and across a retry of it,
 * dropped on success, and dropped by `reset()` when the user changes what they are asking for —
 * because a changed request under an old key is a conflict, and correctly so.
 */
export function useIntentKeys(): {
  keyFor: (id: string) => string;
  clear: (id: string) => void;
  reset: () => void;
} {
  const keys = useRef<Record<string, string>>({});

  const keyFor = useCallback((id: string): string => {
    keys.current[id] ??= mint();
    return keys.current[id];
  }, []);

  const clear = useCallback((id: string): void => {
    delete keys.current[id];
  }, []);

  const reset = useCallback((): void => {
    keys.current = {};
  }, []);

  return { keyFor, clear, reset };
}

/**
 * Turns an idempotency refusal into a sentence a cashier can act on, or `null` when the error is
 * something else entirely.
 *
 * Both codes are 409s about a key, and the raw messages ("Duplicate request (idempotency)") name
 * the mechanism rather than the situation. What the person at the counter needs to know is
 * whether the money moved — and the two answers are opposite:
 *
 *   HMS-REQ-002  it already went through, under this key, for a different amount than the one
 *                you just typed. Reload; do not take it again.
 *   HMS-REQ-004  your first attempt is still running. Wait, then look — do not submit again.
 */
export function idempotencyMessage(err: unknown): string | null {
  if (!(err instanceof ApiClientError)) return null;
  if (err.code === "HMS-REQ-002") {
    return "This was already submitted under the same reference. Reload to see it — do not enter it again.";
  }
  if (err.code === "HMS-REQ-004") {
    return "This is still going through. Give it a moment, then reload to check before trying again.";
  }
  return null;
}
