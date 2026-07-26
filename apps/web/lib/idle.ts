/**
 * Web inactivity policy — the client-side half of the session model.
 *
 * The SERVER decides how long a session may live (short access token, 30-day rotating refresh —
 * see `apps/api/src/config/env.ts`). That is a "keep me signed in" window, and it is correct for a
 * hospital's own devices and for the future mobile app, where users expect to stay logged in.
 *
 * What a shared ward or reception WORKSTATION additionally needs is an inactivity lock: a screen
 * left unattended must not stay open on patient data. That is this module. It is deliberately a
 * UI-side control (the token stays valid; we simply sign the person out locally and revoke it),
 * tuned per deployment rather than baked in — a busy casualty desk and a back-office both read the
 * same app but may want different limits.
 *
 * Set `NEXT_PUBLIC_IDLE_TIMEOUT_MINUTES=0` to disable the lock entirely (e.g. a single-user demo).
 */
function readNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Minutes with no interaction before a signed-in user is warned, then signed out. 0 disables it. */
export const IDLE_TIMEOUT_MINUTES = readNumber(process.env.NEXT_PUBLIC_IDLE_TIMEOUT_MINUTES, 30);

/** How long the "you're about to be signed out" countdown runs before the automatic sign-out. */
export const IDLE_WARN_SECONDS = Math.max(
  10,
  readNumber(process.env.NEXT_PUBLIC_IDLE_WARN_SECONDS, 60),
);

export const IDLE_ENABLED = IDLE_TIMEOUT_MINUTES > 0;
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60_000;
export const IDLE_WARN_MS = IDLE_WARN_SECONDS * 1_000;
