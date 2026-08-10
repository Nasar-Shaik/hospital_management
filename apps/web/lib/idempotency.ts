/**
 * Idempotency keys for money-moving requests (Doc 03 §5.2, Constitution §7).
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
 * second tab. There the server answers HMS-PAY-002 with the original receipt
 * instead of taking the money a second time.
 */
import { useCallback, useState } from "react";

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
 *     await api.recordPayment(id, { amount, method, requestId: payKey });
 *     renewPayKey();
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(mint);
  const renew = useCallback(() => {
    setKey(mint());
  }, []);
  return [key, renew];
}
