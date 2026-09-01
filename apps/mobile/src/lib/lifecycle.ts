/**
 * App lifecycle POLICY (M0 §15) — what should happen, as a pure function.
 *
 * A staff phone is backgrounded and resumed dozens of times an hour, mid-task, with a patient on
 * screen. The defaults are all wrong: the OS keeps a snapshot of the last frame, polling carries on
 * from a pocket, and the screen resumed to is whatever was there an hour ago.
 *
 * The decision is separated from the React `AppState` subscription so it can be tested by calling
 * it, rather than by simulating a phone. `useAppLifecycle` (in `src/hooks`) owns the subscription
 * and performs whatever this returns.
 */

export type AppPhase = "active" | "inactive" | "background";

export interface ResumeActions {
  /** Drop the privacy overlay that was raised before the OS took its snapshot. */
  hideOverlay: boolean;
  /** Re-read `/auth/me` — permissions and roles may have been changed while away. */
  revalidateSession: boolean;
  /** Re-read `/me/branches` and re-validate the active branch (M0 §7). */
  revalidateBranches: boolean;
  /** Mark cached server state stale so visible screens refetch. */
  refetchActive: boolean;
  /** Require biometric/passcode before revealing anything. Designed now, enabled in M2. */
  requireUnlock: boolean;
}

/** Away for less than this and a resume is treated as if the user never left. */
export const SHORT_ABSENCE_MS = 5 * 60_000;
/** Beyond this, the session is re-locked. M2 turns the gate on; M1 only computes the flag. */
export const LOCK_AFTER_MS = 15 * 60_000;

export function actionsOnResume(awayMs: number): ResumeActions {
  const long = awayMs >= SHORT_ABSENCE_MS;
  return {
    hideOverlay: true,
    revalidateSession: long,
    revalidateBranches: long,
    /**
     * Even a brief absence refetches what is on screen. A ward list read four minutes ago is not
     * obviously wrong, but it is not obviously right either, and the cost is one request.
     */
    refetchActive: true,
    requireUnlock: awayMs >= LOCK_AFTER_MS,
  };
}

export interface BackgroundActions {
  /** Raise the overlay. Must happen on `inactive` — by `background` the snapshot is already taken. */
  showOverlay: boolean;
  /** Stop every `refetchInterval`. A queue polling from a pocket is battery, data, and PHI
   *  arriving with nobody looking at it. */
  stopPolling: boolean;
  /** In-flight mutations are ALLOWED to finish. Cancelling a payment mid-flight creates exactly
   *  the ambiguity `Idempotency-Key` exists to resolve. */
  cancelInFlightMutations: false;
}

export function actionsOnPhase(phase: AppPhase): BackgroundActions {
  return {
    showOverlay: phase !== "active",
    stopPolling: phase === "background",
    cancelInFlightMutations: false,
  };
}
