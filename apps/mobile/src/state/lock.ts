/**
 * The lock's state (M2 K) — is the app showing anything, and how many tries are left.
 *
 * ── IT IS A STORE AND NOT COMPONENT STATE, FOR THE SAME REASON THE OTHERS ARE ─
 * `useAppLifecycle` raises the lock from an `AppState` callback, the settings screen changes the
 * preference, and the root gate reads it — three places, none of which is a parent of the others.
 * Held in a component, the flag would be lost by whichever remount happened first, and a lock that
 * disappears on a remount is not a lock.
 *
 * ── STARTS UNLOCKED, AND THAT IS NOT A HOLE ─────────────────────────────────
 * There is nothing to protect until a session exists, and the sign-in screen holds no PHI. The
 * gate goes up on a RESUME (`shouldLock`), which is the only moment PHI can have been left on a
 * screen somebody else is now looking at. A cold start has no such screen — it has a login form.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  NO_BIOMETRICS,
  methodFor,
  type BiometricCapability,
  type LockState,
  type UnlockMethod,
} from "../lib/lock";

export interface LockStoreState {
  state: LockState;
  /** Whether the user turned the gate on. Read from `preferences` at startup. */
  enabled: boolean;
  /** What the device can do. Probed once when the gate goes up, never assumed. */
  capability: BiometricCapability;
  /**
   * Failed attempts on the CURRENT lock. Reset by a successful unlock and by a fresh lock, so a
   * doctor who fumbles once in the morning does not start the afternoon one attempt down.
   */
  failures: number;
  /**
   * Set when the biometric path has been abandoned for this lock — the sensor was unavailable, or
   * the user chose the password. Only ever moves toward `password`, never back, so a failing
   * sensor cannot keep re-offering itself.
   */
  forcePassword: boolean;

  lock(capability: BiometricCapability): void;
  /**
   * Refines what the device can do, WITHOUT touching the attempt counter.
   *
   * Separate from `lock` because the capability probe is async and lands a tick after the gate
   * goes up: re-calling `lock` to deliver the answer would reset `failures`, so a user who had
   * already failed once during that tick would silently get their attempts back. Small window,
   * and the whole point of the counter is that it cannot be reset by anything but a success.
   */
  setCapability(capability: BiometricCapability): void;
  unlock(): void;
  recordFailure(): void;
  usePassword(): void;
  setEnabled(enabled: boolean): void;
  reset(): void;
}

export type LockStore = StoreApi<LockStoreState>;

export function createLockStore(): LockStore {
  return createStore<LockStoreState>((set) => ({
    state: "unlocked",
    enabled: false,
    capability: NO_BIOMETRICS,
    failures: 0,
    forcePassword: false,

    /** The gate goes up. Capability is passed in because probing it is async and this is not. */
    lock: (capability) => set({ state: "locked", capability, failures: 0, forcePassword: false }),

    setCapability: (capability) => set({ capability }),

    unlock: () => set({ state: "unlocked", failures: 0, forcePassword: false }),

    recordFailure: () => {
      set((current) => ({ failures: current.failures + 1 }));
    },

    usePassword: () => set({ forcePassword: true }),

    setEnabled: (enabled) => set({ enabled }),

    /**
     * On sign-out. The gate comes DOWN, because the next screen is the login form and a lock in
     * front of it would demand a fingerprint to reach a password field.
     */
    reset: () =>
      set({ state: "unlocked", capability: NO_BIOMETRICS, failures: 0, forcePassword: false }),
  }));
}

/** Which door to offer right now: the device's best, unless this lock has fallen back. */
export function unlockMethod(state: LockStoreState): UnlockMethod {
  return state.forcePassword ? "password" : methodFor(state.capability);
}
