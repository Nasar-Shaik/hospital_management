/**
 * THE SCREEN LOCK (M2 K) — the policy, the ladder, and the two things it must never do.
 *
 * ── THE TWO CLAIMS WORTH DEFENDING ──────────────────────────────────────────
 * A failed scan NEVER unlocks, and a failed scan never costs the doctor their session until the
 * fifth one. Those pull in opposite directions and both are load-bearing: the first is the point
 * of the feature, and the second is why it will still be switched on in a month. Everything below
 * is one of those two, or the honesty around them (a device with no sensor is gated, not waved
 * through; the counter cannot be reset by anything except a success).
 *
 * The sensor is a port, not a mock of our own code — `createFakeBiometrics` implements the same
 * interface `src/platform/biometrics.ts` does. That is what lets a test fail a scan five times in
 * a row, which no simulator will do on request.
 */
import { describe, expect, it } from "vitest";
import { BRANCH_HYD, PASSWORD, USER, createHarness } from "./support/harness";
import {
  MAX_ATTEMPTS,
  NO_BIOMETRICS,
  afterAttempt,
  attemptMessage,
  canUseBiometrics,
  classifyError,
  methodFor,
  readLockPreference,
  shouldLock,
  writeLockPreference,
  LOCK_AFTER_MS,
} from "../src/lib/lock";
import { createLockStore, unlockMethod } from "../src/state/lock";
import { actionsOnResume } from "../src/lib/lifecycle";
import { storageKeys } from "../src/lib/storage";

const ENROLLED = { hasHardware: true, isEnrolled: true };
const NO_SENSOR = { hasHardware: false, isEnrolled: false };
/** A reader nobody has registered a finger with. Reports hardware, fails every prompt. */
const UNENROLLED = { hasHardware: true, isEnrolled: false };

/* ════════════════════════════════════════════════════════════════════════════
 * 1 · WHEN THE GATE GOES UP
 * ══════════════════════════════════════════════════════════════════════════ */

describe("1. when the app locks", () => {
  const on = { enabled: true, hasSession: true };

  it("locks after a long absence and not after a short one", () => {
    expect(shouldLock({ ...on, awayMs: LOCK_AFTER_MS }, LOCK_AFTER_MS)).toBe(true);
    expect(shouldLock({ ...on, awayMs: LOCK_AFTER_MS + 1 }, LOCK_AFTER_MS)).toBe(true);
    expect(shouldLock({ ...on, awayMs: LOCK_AFTER_MS - 1 }, LOCK_AFTER_MS)).toBe(false);
    // A tab-away to check a phone number is not an absence.
    expect(shouldLock({ ...on, awayMs: 0 }, LOCK_AFTER_MS)).toBe(false);
  });

  it("never locks a signed-out app", () => {
    /**
     * A lock in front of the login screen protects nothing and cannot be removed without the
     * password it is standing in front of — on a device whose enrolment has just been wiped, that
     * is an app nobody can open.
     */
    expect(
      shouldLock({ enabled: true, hasSession: false, awayMs: 60 * 60_000 }, LOCK_AFTER_MS),
    ).toBe(false);
  });

  it("never locks when the user has not turned it on", () => {
    expect(
      shouldLock({ enabled: false, hasSession: true, awayMs: 60 * 60_000 }, LOCK_AFTER_MS),
    ).toBe(false);
  });

  it("locks a device with NO sensor — capability decides the method, not whether to lock", () => {
    /**
     * The bug this forbids: making capability part of the lock decision, so that turning the gate
     * on does nothing at all on the one device that most needs it.
     */
    expect(shouldLock({ ...on, awayMs: LOCK_AFTER_MS }, LOCK_AFTER_MS)).toBe(true);
    expect(methodFor(NO_SENSOR)).toBe("password");
    expect(methodFor(UNENROLLED)).toBe("password");
    expect(methodFor(ENROLLED)).toBe("biometric");
  });

  it("requires hardware AND enrolment — they fail independently", () => {
    expect(canUseBiometrics(ENROLLED)).toBe(true);
    expect(canUseBiometrics(UNENROLLED)).toBe(false);
    expect(canUseBiometrics(NO_BIOMETRICS)).toBe(false);
  });

  it("agrees with the lifecycle policy that already computed the threshold", () => {
    // `requireUnlock` was designed in M1 and left unwired. K must act on the SAME number, not a
    // second one that drifts from it.
    expect(actionsOnResume(LOCK_AFTER_MS).requireUnlock).toBe(true);
    expect(actionsOnResume(LOCK_AFTER_MS - 1).requireUnlock).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2 · WHAT AN ATTEMPT COSTS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("2. the attempt ladder", () => {
  it("unlocks ONLY on success", () => {
    expect(afterAttempt("success", 0).outcome).toBe("unlocked");
    expect(afterAttempt("success", MAX_ATTEMPTS - 1).outcome).toBe("unlocked");
    // The claim the whole feature rests on: nothing else opens the gate.
    for (const result of ["failed", "cancelled", "unavailable"] as const) {
      expect(afterAttempt(result, 0).outcome).not.toBe("unlocked");
    }
  });

  it("counts failures up to MAX_ATTEMPTS and then ends the session", () => {
    for (let failures = 0; failures < MAX_ATTEMPTS - 1; failures += 1) {
      const outcome = afterAttempt("failed", failures);
      expect(outcome.outcome).toBe("retry");
      expect(outcome.outcome === "retry" && outcome.attemptsLeft).toBe(MAX_ATTEMPTS - failures - 1);
    }
    expect(afterAttempt("failed", MAX_ATTEMPTS - 1).outcome).toBe("signOut");
  });

  it("does NOT count a cancellation — dismissing a prompt is not an intruder", () => {
    /**
     * A call arrives, the phone is handed over, the user taps away. Counting those toward a
     * sign-out would end sessions for reasons that have nothing to do with security — and would
     * mean a doctor who cannot use the sensor burns their attempts just reaching the password.
     */
    const outcome = afterAttempt("cancelled", 2);
    expect(outcome.outcome).toBe("retry");
    expect(outcome.outcome === "retry" && outcome.attemptsLeft).toBe(MAX_ATTEMPTS - 2);
  });

  it("sends an unusable sensor to the password door without charging an attempt", () => {
    // OS lockout, no enrolment, or the user tapping "Use password". None is a failed scan.
    expect(afterAttempt("unavailable", 0).outcome).toBe("password");
    expect(afterAttempt("unavailable", MAX_ATTEMPTS - 1).outcome).toBe("password");
  });

  it("warns only when the warning is worth reading", () => {
    expect(attemptMessage(MAX_ATTEMPTS)).toBeUndefined();
    expect(attemptMessage(MAX_ATTEMPTS - 1)).toBeUndefined();
    expect(attemptMessage(2)).toContain("2 attempts left");
    expect(attemptMessage(1)).toContain("One more");
  });
});

describe("2b. the OS's refusal codes", () => {
  /**
   * ── THE MAPPING IS WHERE A SESSION GETS LOST QUIETLY ────────────────────────
   * This was originally written inside the platform adapter, where no test could reach it — and a
   * deliberate miscategorisation of `user_cancel` there reddened NOTHING. That is exactly the shape
   * of bug that ships: five dismissed prompts would sign a doctor out, and no screenshot, type or
   * gate would show it. Moving it into `src/lib` is what makes the table below possible.
   *
   * Every code in `LocalAuthenticationError` (expo-local-authentication 17) is named here.
   */
  it.each([
    ["user_cancel", "cancelled"],
    ["system_cancel", "cancelled"],
    ["app_cancel", "cancelled"],
    ["lockout", "unavailable"],
    ["not_available", "unavailable"],
    ["not_enrolled", "unavailable"],
    ["passcode_not_set", "unavailable"],
    ["user_fallback", "unavailable"],
    ["authentication_failed", "failed"],
    ["timeout", "failed"],
    ["unable_to_process", "failed"],
    ["no_space", "failed"],
    ["invalid_context", "failed"],
    ["unknown", "failed"],
  ] as const)("%s → %s", (code, expected) => {
    expect(classifyError(code)).toBe(expected);
  });

  it("treats an unfamiliar code from a future SDK as a failed scan, never as an unlock", () => {
    // Conservative by default. An unrecognised refusal is not a reason to open the gate — and it
    // is the one bucket that costs an attempt, so it also cannot loop forever.
    expect(classifyError("something_new_in_sdk_55")).toBe("failed");
    expect(classifyError(undefined)).toBe("failed");
  });

  it("no code anywhere in the table unlocks", () => {
    const every = [
      "user_cancel",
      "system_cancel",
      "app_cancel",
      "lockout",
      "not_available",
      "not_enrolled",
      "passcode_not_set",
      "user_fallback",
      "authentication_failed",
      "timeout",
      "unable_to_process",
      "no_space",
      "invalid_context",
      "unknown",
      undefined,
    ];
    for (const code of every) {
      expect(afterAttempt(classifyError(code), 0).outcome).not.toBe("unlocked");
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3 · THE STORE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("3. the lock store", () => {
  it("starts unlocked — a cold start has a login form, not a chart", () => {
    const store = createLockStore();
    expect(store.getState().state).toBe("unlocked");
  });

  it("resets the counter when the gate goes up, but never mid-lock", () => {
    const store = createLockStore();
    store.getState().lock(ENROLLED);
    store.getState().recordFailure();
    store.getState().recordFailure();
    expect(store.getState().failures).toBe(2);

    /**
     * The capability probe lands a tick AFTER the gate goes up. Delivering it through `lock` would
     * hand back the two spent attempts — which is the one thing the counter must not allow.
     */
    store.getState().setCapability(UNENROLLED);
    expect(store.getState().failures).toBe(2);
    expect(store.getState().capability).toEqual(UNENROLLED);

    // A NEW lock is a fresh start: yesterday's fumble is not held against this morning.
    store.getState().lock(ENROLLED);
    expect(store.getState().failures).toBe(0);
  });

  it("falls back to the password door and never back again", () => {
    const store = createLockStore();
    store.getState().lock(ENROLLED);
    expect(unlockMethod(store.getState())).toBe("biometric");

    store.getState().usePassword();
    // A failing sensor must not keep re-offering itself for the rest of the lock.
    expect(unlockMethod(store.getState())).toBe("password");
    expect(store.getState().forcePassword).toBe(true);
  });

  it("clears everything on unlock and on reset", () => {
    const store = createLockStore();
    store.getState().lock(ENROLLED);
    store.getState().recordFailure();
    store.getState().usePassword();

    store.getState().unlock();
    expect(store.getState()).toMatchObject({
      state: "unlocked",
      failures: 0,
      forcePassword: false,
    });

    store.getState().lock(ENROLLED);
    store.getState().reset();
    expect(store.getState().state).toBe("unlocked");
  });

  it("keeps `enabled` across a lock cycle — it is a setting, not lock state", () => {
    const store = createLockStore();
    store.getState().setEnabled(true);
    store.getState().lock(ENROLLED);
    store.getState().unlock();
    expect(store.getState().enabled).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4 · THE PREFERENCE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("4. the setting", () => {
  it("is off unless it says exactly `true`", () => {
    expect(readLockPreference("true")).toBe(true);
    expect(readLockPreference("false")).toBe(false);
    expect(readLockPreference(undefined)).toBe(false);
    // A corrupt or half-written value fails toward the recoverable state.
    expect(readLockPreference("")).toBe(false);
    expect(readLockPreference("TRUE")).toBe(false);
    expect(readLockPreference("1")).toBe(false);
  });

  it("round-trips", () => {
    expect(readLockPreference(writeLockPreference(true))).toBe(true);
    expect(readLockPreference(writeLockPreference(false))).toBe(false);
  });

  it("is scoped per hospital, so one profile's choice is not the other's", () => {
    expect(storageKeys.screenLock("apollo")).not.toBe(storageKeys.screenLock("fortis"));
  });

  it("is written to preferences under the scoped key, and read back on the next launch", async () => {
    const h = createHarness();

    // What the Settings toggle does.
    await h.preferences.set(storageKeys.screenLock("apollo"), writeLockPreference(true));

    // What `createRuntime` does at startup. Driven directly rather than by racing a constructor:
    // the read is fire-and-forget by design (the gate only matters minutes later), so awaiting a
    // constructor side effect would be testing the scheduler.
    const stored = await h.preferences.get(storageKeys.screenLock("apollo"));
    h.runtime.lock.getState().setEnabled(readLockPreference(stored));

    expect(h.runtime.lock.getState().enabled).toBe(true);
  });

  it("a runtime whose preference read fails simply stays off", async () => {
    const h = createHarness();
    // Nothing stored — a fresh install, or a read that failed and was swallowed.
    const stored = await h.preferences.get(storageKeys.screenLock("apollo"));
    h.runtime.lock.getState().setEnabled(readLockPreference(stored));

    // Off is the state a user can always recover from in Settings. A gate stuck ON with no
    // enrolled finger would be a locked-out doctor.
    expect(h.runtime.lock.getState().enabled).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5 · THE WHOLE THING, THROUGH A REAL RUNTIME
 * ══════════════════════════════════════════════════════════════════════════ */

async function signedIn() {
  const h = createHarness();
  h.happyPath({ branches: [BRANCH_HYD] });
  await h.runtime.auth.signIn(USER.email, PASSWORD, "device");
  await h.runtime.branches.select(USER.id, BRANCH_HYD.id);
  h.runtime.lock.getState().setEnabled(true);
  return h;
}

describe("5. locking and unlocking a real session", () => {
  it("holds the session through a lock — the token is NOT discarded", async () => {
    const h = await signedIn();
    const before = await h.secureStore.get(storageKeys.refreshToken("apollo"));

    h.runtime.lock.getState().lock(ENROLLED);

    /**
     * The core of the design. A lock is a SCREEN gate over a valid session: the refresh token stays
     * in the Keychain, the cache stays warm, and unlocking is instant and offline. A gate that
     * signed the doctor out would need the network to undo itself — on a ward, at the worst moment.
     */
    expect(h.runtime.lock.getState().state).toBe("locked");
    expect(await h.secureStore.get(storageKeys.refreshToken("apollo"))).toBe(before);
    expect(h.runtime.session.getState().user).toBeDefined();
    expect(h.sessionEndings).toEqual([]);
  });

  it("a failed scan leaves the session completely alone", async () => {
    const h = await signedIn();
    h.runtime.lock.getState().lock(ENROLLED);
    h.biometrics.next("failed");

    const result = await h.biometrics.authenticate("Unlock MediCore");
    const outcome = afterAttempt(result, h.runtime.lock.getState().failures);
    if (outcome.outcome === "retry") h.runtime.lock.getState().recordFailure();

    expect(outcome.outcome).toBe("retry");
    expect(h.runtime.lock.getState().state).toBe("locked");
    expect(h.sessionEndings).toEqual([]);
    expect(h.runtime.session.getState().user).toBeDefined();
  });

  it("five failures end the session, and the gate comes down with it", async () => {
    const h = await signedIn();
    h.runtime.lock.getState().lock(ENROLLED);
    h.biometrics.answer = "failed";

    let ended = false;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const result = await h.biometrics.authenticate("Unlock MediCore");
      const outcome = afterAttempt(result, h.runtime.lock.getState().failures);
      h.runtime.lock.getState().recordFailure();
      if (outcome.outcome === "signOut") {
        await h.runtime.auth.signOut();
        ended = true;
      }
    }

    expect(ended).toBe(true);
    expect(h.sessionEndings).toContain("userSignedOut");
    expect(await h.secureStore.get(storageKeys.refreshToken("apollo"))).toBeUndefined();
    /**
     * And the gate is DOWN. `onSessionEnded` resets it, because the next screen is the login form
     * — a lock in front of that would be an app nobody could open.
     */
    expect(h.runtime.lock.getState().state).toBe("unlocked");
  });

  it("signing out from the lock screen always works, from the first render", async () => {
    const h = await signedIn();
    h.runtime.lock.getState().lock(NO_SENSOR);

    await h.runtime.auth.signOut();

    // Nobody is ever trapped behind a sensor that has stopped reading.
    expect(h.runtime.lock.getState().state).toBe("unlocked");
    expect(h.sessionEndings).toContain("userSignedOut");
  });

  it("a success unlocks and clears the record of the failures", async () => {
    const h = await signedIn();
    h.runtime.lock.getState().lock(ENROLLED);
    h.biometrics.next("failed", "failed", "success");

    for (let i = 0; i < 3; i += 1) {
      const result = await h.biometrics.authenticate("Unlock MediCore");
      const outcome = afterAttempt(result, h.runtime.lock.getState().failures);
      if (outcome.outcome === "unlocked") h.runtime.lock.getState().unlock();
      else if (result === "failed") h.runtime.lock.getState().recordFailure();
    }

    expect(h.runtime.lock.getState().state).toBe("unlocked");
    expect(h.runtime.lock.getState().failures).toBe(0);
  });

  it("reports the device honestly rather than assuming a sensor", async () => {
    const h = await signedIn();
    h.biometrics.capabilityIs(UNENROLLED);

    const capability = await h.runtime.biometrics!.capability();
    h.runtime.lock.getState().lock(capability);

    // Hardware present, nobody enrolled — offering a prompt here would fail every single time.
    expect(unlockMethod(h.runtime.lock.getState())).toBe("password");
  });

  it("a runtime built with no authenticator still locks, by password", () => {
    const h = createHarness();
    h.runtime.lock.getState().setEnabled(true);
    h.runtime.lock.getState().lock(NO_BIOMETRICS);

    expect(h.runtime.lock.getState().state).toBe("locked");
    expect(unlockMethod(h.runtime.lock.getState())).toBe("password");
  });

  it("tells the user what they are unlocking", async () => {
    const h = await signedIn();
    await h.runtime.biometrics!.authenticate("Unlock MediCore");
    // The OS sheet has no other context — a bare "Authenticate" tells nobody which app is asking.
    expect(h.biometrics.prompts[0]).toContain("MediCore");
  });
});
