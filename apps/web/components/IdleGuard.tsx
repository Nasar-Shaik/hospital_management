"use client";

/**
 * Inactivity lock for signed-in sessions (the workstation half of the session model — see
 * `lib/idle.ts` for the why and the knobs).
 *
 * A signed-in user who stops interacting is warned, then signed out and returned to a login screen
 * that explains what happened. The session's TOKENS are not the mechanism here — they stay valid,
 * kept fresh by AuthProvider's silent-refresh timer — so this is purely a "don't leave patient data
 * open on an unattended screen" control. When it fires we call the real `logout()`, which also
 * revokes the refresh family server-side, so an idle sign-out is a genuine sign-out, not a cosmetic
 * one.
 *
 * ── ROBUSTNESS ───────────────────────────────────────────────────────────────
 * We do NOT trust a single long `setTimeout`: background tabs throttle timers, and a laptop that
 * sleeps for two hours fires nothing at all. Instead we stamp `lastActivity` on interaction and,
 * on a 1-second tick (plus an immediate check when the tab regains focus/visibility), compare it to
 * wall-clock time. A machine that wakes past the limit is signed out on the very next check, not
 * whenever a stale timer happens to catch up.
 *
 * While the warning dialog is open, passive activity (a jiggled mouse) does NOT dismiss it: the
 * person must explicitly choose to stay. An unattended screen does not move its own mouse, so the
 * dialog staying up is exactly the intended behaviour.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { Button } from "./ui";
import { IDLE_ENABLED, IDLE_TIMEOUT_MS, IDLE_WARN_MS, IDLE_WARN_SECONDS } from "../lib/idle";

/** Interactions that count as "the user is still here". Passive + deliberate, capture-phase. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "scroll", "touchstart"] as const;

export function IdleGuard() {
  const { user, logout } = useAuth();
  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(IDLE_WARN_SECONDS);

  const lastActivity = useRef<number>(Date.now());
  // Latch so a slow logout call cannot fire twice while the redirect is in flight.
  const signingOut = useRef(false);
  // Read inside event/interval callbacks without re-subscribing them every render.
  const warningRef = useRef(false);
  warningRef.current = warning;

  const signOut = useCallback(() => {
    if (signingOut.current) return;
    signingOut.current = true;
    void logout({ redirectTo: "/login?reason=timeout" });
  }, [logout]);

  useEffect(() => {
    // Inert unless enabled AND someone is actually signed in — the public site and the login page
    // both mount this, and neither should ever arm the lock.
    if (!IDLE_ENABLED || !user) {
      setWarning(false);
      signingOut.current = false;
      return;
    }

    lastActivity.current = Date.now();
    signingOut.current = false;

    const markActive = () => {
      // A jiggled mouse must not silently cancel an open warning — that decision is the button's.
      if (warningRef.current) return;
      lastActivity.current = Date.now();
    };

    const check = () => {
      if (signingOut.current) return;
      const idleFor = Date.now() - lastActivity.current;

      if (idleFor >= IDLE_TIMEOUT_MS) {
        signOut();
        return;
      }
      if (idleFor >= IDLE_TIMEOUT_MS - IDLE_WARN_MS) {
        setWarning(true);
        setRemaining(Math.max(0, Math.ceil((IDLE_TIMEOUT_MS - idleFor) / 1000)));
      } else if (warningRef.current) {
        setWarning(false);
      }
    };

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, markActive, { passive: true, capture: true });
    }
    // A tab returning to the foreground (or a machine waking) must be judged immediately, before
    // the next 1s tick — otherwise a long sleep shows a stale screen for a moment.
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);

    const interval = window.setInterval(check, 1_000);

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, markActive, { capture: true });
      }
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.clearInterval(interval);
    };
  }, [user, signOut]);

  const stay = useCallback(() => {
    lastActivity.current = Date.now();
    setWarning(false);
  }, []);

  if (!warning || !user) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
      aria-describedby="idle-desc"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-warning)]/15 text-[var(--color-warning)]"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <div>
            <h2 id="idle-title" className="text-base font-semibold text-[var(--color-fg)]">
              Still there?
            </h2>
            <p className="text-sm text-[var(--color-fg-muted)]">For your security</p>
          </div>
        </div>

        <p id="idle-desc" className="mt-4 text-sm text-[var(--color-fg)]">
          You&rsquo;ve been inactive for a while. To protect patient information, you&rsquo;ll be
          signed out in{" "}
          <span className="font-semibold tabular-nums text-[var(--color-fg)]">{remaining}s</span>.
        </p>

        <div className="mt-6 flex gap-3">
          <Button onClick={stay} className="flex-1">
            Stay signed in
          </Button>
          <Button variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
