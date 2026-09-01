/**
 * Idempotency keys — one per user INTENT, not one per HTTP call.
 *
 * ── A KEY MINTED INSIDE THE CLIENT PROTECTS NOTHING ─────────────────────────
 * That is worth stating plainly because it is the obvious implementation and it is useless: a
 * double-tap makes two calls, each mints its own key, and the server sees two unrelated orders and
 * draws two tubes of blood. The key has to name the INTENT — "this order, the one I am submitting
 * now" — so it must be stable across every retry of that submission and different for a genuinely
 * new one. Only the caller knows which is which, which is why `ApiClient` takes the key and never
 * invents it.
 *
 * ── WHAT A RETRY ACTUALLY LOOKS LIKE HERE ───────────────────────────────────
 * Not a double-tap; a `busy` flag already stops that. The case this exists for is the one a
 * disabled button cannot see: the request reached the server, the order was created, and the
 * response was lost. The doctor sees "could not place" and presses again. With the same key the
 * server replays the original 201 byte for byte; without it, a second real order exists.
 *
 * ── NO `crypto` DEPENDENCY, DELIBERATELY ────────────────────────────────────
 * Hermes has no `crypto.randomUUID`, and `expo-crypto` would be a native module in `src/lib` —
 * which the boundary rules forbid and the Node test suite could not load. It is also not needed:
 * this is a correlation token, not a secret. The server scopes keys to the authenticated caller
 * (the middleware is mounted after `authenticate` precisely so a key has an owner), so the only
 * collision that could matter is one user colliding with themselves inside the store's retention
 * window. Two independent 48-bit-ish random components plus a millisecond timestamp make that
 * unreachable in a clinic day.
 *
 * `crypto.randomUUID` is still preferred when a runtime happens to provide it — some RN setups
 * polyfill it, and a real UUID is easier to grep for in a server log.
 */

/** The server accepts 8–128 chars of `[A-Za-z0-9_.:@+-]`; everything below stays well inside that. */
export function newIntentKey(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (typeof uuid === "function") return uuid.call(globalThis.crypto);

  const part = (): string => Math.random().toString(36).slice(2, 12);
  return `k-${Date.now().toString(36)}-${part()}-${part()}`;
}

/**
 * A set of keys held against one submission — the order pad's shape.
 *
 * A basket of three tests is three requests, each needing its OWN key (they are three different
 * intents), and all three must survive a retry of the basket unchanged. `reset()` is called once
 * the submission has landed, so the next basket is genuinely new.
 *
 * Vanilla rather than a hook so the behaviour is testable in Node; `useIntentKeys` binds it.
 */
export interface IntentKeys {
  /** The key for one item in this submission. Stable until `reset`. */
  keyFor(name: string): string;
  /** The submission is over. The next one gets fresh keys. */
  reset(): void;
  /** For tests and logs: what has been minted so far. */
  snapshot(): Record<string, string>;
}

export function createIntentKeys(mint: () => string = newIntentKey): IntentKeys {
  let keys = new Map<string, string>();
  return {
    keyFor(name) {
      const existing = keys.get(name);
      if (existing) return existing;
      const minted = mint();
      keys.set(name, minted);
      return minted;
    },
    reset() {
      keys = new Map<string, string>();
    },
    snapshot() {
      return Object.fromEntries(keys);
    },
  };
}
