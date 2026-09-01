/**
 * THE LOCK POLICY (M2 K) — when the app hides itself, and what a failed unlock costs.
 *
 * ── WHAT THIS GATE IS, AND WHAT IT IS NOT ───────────────────────────────────
 * It is a SCREEN gate over a session that is already valid. The refresh token stays in the
 * Keychain, the access token stays live, the query cache stays warm — the only thing that changes
 * is whether anything is rendered. It is not authentication: the server has already decided who
 * this is, and a biometric scan on a phone proves nothing to a server that never saw it.
 *
 * So the threat it addresses is precise and local: **a doctor's unlocked phone, put down.** On a
 * ward that happens constantly — a phone on a trolley, in a pocket handed to a colleague, on the
 * desk while both hands are busy. The device passcode covers the case where the phone locks
 * itself; this covers the fifteen minutes before it does.
 *
 * ── THE TWO FAILURES PULL IN OPPOSITE DIRECTIONS, AND BOTH ARE REAL ─────────
 * A gate that is too weak leaves PHI on a table. A gate that is too strong is worse than none,
 * because of how it actually fails:
 *
 *   A doctor's thumb is wet, or gloved, or the sensor is under a screen protector. If a failed
 *   scan ended the session, they would be thrown to a password screen mid-round, on a ward with no
 *   signal, holding a phone that now needs the network to become useful again. The predictable
 *   response is to turn the gate off — and a feature everyone disables protects nobody.
 *
 * So a failed scan costs NOTHING except another attempt, and the escape hatch is always open:
 * `signOut` is offered from the lock screen from the first failure, so nobody is ever trapped.
 * The session is only discarded after `MAX_ATTEMPTS`, which is the shape that actually matches the
 * threat — a stranger guessing at a found phone runs out of tries; the owner never gets near it.
 *
 * ── UNAVAILABLE IS NOT UNLOCKED ─────────────────────────────────────────────
 * A device with no sensor, or with one nobody has enrolled, cannot satisfy this gate. It must not
 * therefore be given a free pass — a hospital that turned the setting on expects it to mean
 * something. `methodFor` sends that device to the PASSWORD path instead: still gated, still
 * usable, no biometric theatre. The one thing it never does is silently unlock.
 */

/** Away for less than this and the resume is treated as if the user never left (`lifecycle.ts`). */
export { LOCK_AFTER_MS } from "./lifecycle";

/**
 * How many failed unlocks before the session is actually discarded.
 *
 * Five, not three: the sensors these run on fail honestly and often — wet hands, a glove, a mask
 * against Face ID, a screen protector. Three would catch real doctors on a real ward. It is also
 * not fifty: the number has to be small enough that a found phone is not worth sitting down with.
 *
 * A stranger has no path to five successes; an owner rarely needs more than two attempts.
 */
export const MAX_ATTEMPTS = 5;

/** What the app is currently allowed to render. */
export type LockState =
  /** Everything is visible. The only state in which a chart may paint. */
  | "unlocked"
  /** The gate is up. Nothing below it renders — see `components/LockGate.tsx`. */
  | "locked";

/** How the user may get past the gate on THIS device, right now. */
export type UnlockMethod =
  /** A fingerprint or a face — the device has hardware and somebody has enrolled on it. */
  | "biometric"
  /** No usable sensor. The only honest way through is to prove the password again. */
  | "password";

/** What the device can actually do, read once at the gate rather than assumed. */
export interface BiometricCapability {
  /** There is a sensor. */
  hasHardware: boolean;
  /** Somebody has enrolled a fingerprint or a face ON THIS DEVICE. Hardware alone is not enough. */
  isEnrolled: boolean;
}

export const NO_BIOMETRICS: BiometricCapability = { hasHardware: false, isEnrolled: false };

/**
 * Is the biometric path available at all?
 *
 * Both halves are required and they fail independently: a phone can have a fingerprint reader that
 * nobody has ever registered a finger with, which reports hardware and would then fail every
 * prompt. Asking for both is what keeps the lock screen from offering something that cannot work.
 */
export function canUseBiometrics(capability: BiometricCapability): boolean {
  return capability.hasHardware && capability.isEnrolled;
}

export interface LockInput {
  /** The user turned the gate on in Settings. Off by default — see `readLockPreference`. */
  enabled: boolean;
  /** There is a session to protect. No session, no gate: the login screen holds no PHI. */
  hasSession: boolean;
  /** How long the app was in the background, from `useAppLifecycle`. */
  awayMs: number;
}

/**
 * Should the gate be up after this resume?
 *
 * ── THE ORDER OF THESE CHECKS IS THE POLICY ─────────────────────────────────
 * `hasSession` first, because locking a signed-out app would put a fingerprint prompt in front of
 * the login screen — protecting nothing, and unremovable without the password it is standing in
 * front of. `enabled` second, because a user who has not turned this on must never meet it.
 * `awayMs` last, because it is the only one that is a judgement rather than a fact.
 *
 * Note what is NOT here: the device's capability. A phone with no sensor still locks — it just
 * unlocks by password (`methodFor`). Making capability part of THIS decision is the bug where
 * turning the gate on does nothing on the one device that most needs it.
 */
export function shouldLock(input: LockInput, lockAfterMs: number): boolean {
  if (!input.hasSession) return false;
  if (!input.enabled) return false;
  return input.awayMs >= lockAfterMs;
}

/** Which door this device offers. Capability decides the METHOD, never whether to lock. */
export function methodFor(capability: BiometricCapability): UnlockMethod {
  return canUseBiometrics(capability) ? "biometric" : "password";
}

/* ════════════════════════════════════════════════════════════════════════════
 * WHAT A FAILED ATTEMPT COSTS
 * ══════════════════════════════════════════════════════════════════════════ */

/** Why an unlock attempt ended. Mapped from the platform's result, never from a message string. */
export type AttemptResult =
  /** The scan matched. The ONLY value that may unlock. */
  | "success"
  /** The scan ran and did not match. */
  | "failed"
  /** The user dismissed the prompt. Not a failure — they chose not to, and may try again. */
  | "cancelled"
  /** The sensor is locked out by the OS, or the module is unavailable. Falls back to password. */
  | "unavailable";

export type LockOutcome =
  /** Render the app. */
  | { outcome: "unlocked" }
  /** Stay locked, offer another go. `attemptsLeft` is shown so nobody is surprised by the end. */
  | { outcome: "retry"; attemptsLeft: number }
  /** Stay locked, and stop offering biometrics — the password is the only way through now. */
  | { outcome: "password" }
  /** Too many failures. The session is discarded and the user signs in again. */
  | { outcome: "signOut" };

/**
 * What happens after one attempt.
 *
 *     success      → unlocked, always, and the counter resets
 *     cancelled    → retry, and the counter does NOT move
 *     unavailable  → password (the sensor cannot answer; do not punish the user for it)
 *     failed       → retry until MAX_ATTEMPTS, then signOut
 *
 * ── CANCELLING IS NOT FAILING, AND THAT DISTINCTION MATTERS ─────────────────
 * Dismissing the prompt is what happens when a doctor is handed the phone, taps away to check
 * something, or the OS interrupts with a call. Counting those toward a sign-out would mean the
 * gate ends sessions for reasons that have nothing to do with an intruder — and, worse, that a
 * doctor who cannot currently use the sensor cannot get to the password screen without burning
 * their attempts to reach it.
 */
export function afterAttempt(result: AttemptResult, failuresSoFar: number): LockOutcome {
  if (result === "success") return { outcome: "unlocked" };
  if (result === "cancelled") return { outcome: "retry", attemptsLeft: remaining(failuresSoFar) };
  if (result === "unavailable") return { outcome: "password" };

  const failures = failuresSoFar + 1;
  if (failures >= MAX_ATTEMPTS) return { outcome: "signOut" };
  return { outcome: "retry", attemptsLeft: MAX_ATTEMPTS - failures };
}

function remaining(failures: number): number {
  return Math.max(0, MAX_ATTEMPTS - failures);
}

/**
 * The sentence under the prompt. Written for somebody holding a phone on a ward, not for a log.
 *
 * The attempt count only appears once it is worth knowing. "4 attempts remaining" on the first
 * try reads as an accusation; on the last two it is the warning that stops a doctor being signed
 * out by surprise between patients.
 */
export function attemptMessage(attemptsLeft: number): string | undefined {
  if (attemptsLeft >= MAX_ATTEMPTS - 1) return undefined;
  if (attemptsLeft <= 1) return "One more failed attempt will sign you out.";
  return `${String(attemptsLeft)} attempts left before you are signed out.`;
}

/**
 * The OS's refusal code, classified.
 *
 * ── THIS IS POLICY, SO IT LIVES HERE AND NOT IN THE ADAPTER ─────────────────
 * It looks like plumbing and it is not: getting `user_cancel` into the wrong bucket means five
 * dismissed prompts sign a doctor out, and getting `lockout` wrong means the app spends the user's
 * attempts on a sensor the OS has already switched off. Neither is visible in a screenshot and
 * neither is caught by the platform adapter's own types.
 *
 * Kept in `src/lib` for the same reason as everything else here: it is testable by calling it,
 * exhaustively, against the codes the module actually declares — which is exactly what
 * `src/platform/biometrics.ts` cannot be.
 *
 * The union is `LocalAuthenticationError` (expo-local-authentication 17). Widened to `string` so
 * this module imports nothing from the native package, and so an unfamiliar code from a future
 * version lands on the conservative default rather than failing to compile.
 */
export function classifyError(error: string | undefined): Exclude<AttemptResult, "success"> {
  switch (error) {
    /** Dismissed. Not a failure — a call arrived, or the phone was handed over. Costs nothing. */
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
      return "cancelled";

    /**
     * The sensor cannot answer at all. `lockout` is the OS having disabled it after its OWN run of
     * failures; the rest mean there was never a door here. `user_fallback` is the user TAPPING
     * "Use password" — a choice, and the clearest possible request for the other door.
     * Charging an attempt for any of these spends the user's five on something that was never
     * going to say yes.
     */
    case "lockout":
    case "not_available":
    case "not_enrolled":
    case "passcode_not_set":
    case "user_fallback":
      return "unavailable";

    /**
     * The scan ran and did not succeed: `authentication_failed`, `timeout`, `unable_to_process`,
     * `no_space`, `invalid_context`, `unknown` — and anything a later SDK adds. The only bucket
     * that costs a try, and the right default: an unrecognised refusal is not a reason to open.
     */
    default:
      return "failed";
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE PREFERENCE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The stored setting. The KEY lives in `storageKeys.screenLock` with every other one — see there
 * for why it is a preference rather than a Keychain entry, and note it is scoped per hospital,
 * because a user may hold accounts at two and want the gate on for only one.
 *
 * Parsed strictly: anything that is not the string `"true"` is off. A corrupt or half-written
 * value therefore fails toward the state the user can always recover from — a gate that will not
 * come up is a visible annoyance; a gate that comes up unexpectedly on a device with no enrolled
 * finger is a doctor locked out mid-round.
 */
/**
 * OFF by default, deliberately.
 *
 * A security control switched on for somebody who did not ask for it and cannot find the switch is
 * how a doctor gets locked out of a chart in front of a patient. The hospital's real protection is
 * the device passcode, which is policy-enforced by MDM in the deployments that need it; this is an
 * addition a user opts into. M2 L may revisit whether an admin can require it — that is a server
 * policy question and there is no endpoint for it today.
 */
export function readLockPreference(stored: string | undefined): boolean {
  return stored === "true";
}

export function writeLockPreference(enabled: boolean): string {
  return enabled ? "true" : "false";
}
