/**
 * Shared domain-neutral types (Doc 04 §1). Business DTOs are added per module
 * in later phases via `z.infer<>` from @medicore/validation — never hand-written
 * duplicates (Doc 09 §5).
 */

/** Standard API response envelope (Doc 04 §2.3, Doc 09 §4). */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  meta?: PageMeta;
  error?: ApiError;
}

export interface ApiError {
  /** Code from docs/ERROR_CODES.md — the only legal source. */
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export interface PageMeta {
  page: number;
  limit: number;
  total?: number;
  hasMore?: boolean;
}

/** Health/readiness contract shared by all services (Doc 04 §8). */
export interface HealthStatus {
  status: "ok";
  service: string;
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessStatus {
  status: "ready" | "degraded";
  service: string;
  checks: Record<string, "up" | "down" | "skipped">;
}

/**
 * Android notification channels (M4 · K4-01).
 *
 * ── WHY THESE LIVE IN A SHARED PACKAGE AND NOT ON EITHER SIDE ───────────────
 * The API names a channel in every push it sends; the app creates the channels on the handset.
 * If those two ever disagree, Android does not fall back and does not warn — **it displays
 * nothing at all**. A critical potassium would be accepted by Expo, ticketed `ok`, delivered to
 * the device, and silently dropped by the OS. There is no log, no error and no ticket that says
 * so, which makes a typo here indistinguishable from a phone in a drawer.
 *
 * One definition, imported by both, so the drift cannot happen. `notificationChannels.test.ts`
 * pins the mapping; `push.int.test.ts` asserts on what actually goes over the wire.
 *
 * ── AND WHY THE IDS WILL NEVER BE REUSED FOR A DIFFERENT IMPORTANCE ─────────
 * A channel's importance is fixed when the OS first creates it. After that it belongs to the
 * USER — an app may lower it, never raise it, and `setNotificationChannelAsync` on an existing id
 * silently keeps whatever the user has. So changing the importance of one of these means a NEW
 * id, not an edit. (Nothing has shipped yet, so today's ids are free of that history.)
 */
export const PUSH_CHANNEL = {
  /** HIGH importance: interrupts, makes a sound, shows over the lock screen. Clinical urgency only. */
  critical: "critical",
  /**
   * DEFAULT importance: arrives, waits, does not interrupt. Everything else.
   *
   * Named `default` because it is also what `expo-notifications`' `defaultChannel` points at in
   * `app.config.ts` — a message that somehow carries no channel of its own lands here rather than
   * in the one that makes a noise. Routine traffic must never be able to train a ward to ignore
   * the phone.
   */
  routine: "default",
} as const;

export type PushChannelId = (typeof PUSH_CHANNEL)[keyof typeof PUSH_CHANNEL];
