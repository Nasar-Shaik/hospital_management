/**
 * Storage PORTS — the seam that keeps the security-critical logic testable.
 *
 * ── WHY AN INTERFACE AND NOT A DIRECT IMPORT ────────────────────────────────
 * `expo-secure-store` is a native module. Importing it anywhere in `src/lib` would make every file
 * that touches a session un-runnable outside a simulator, and the session lifecycle is precisely
 * the part that must be proven by a test rather than by trying it on a phone. So `src/lib` depends
 * on these two interfaces, `src/platform` implements them against Keychain/Keystore and
 * AsyncStorage, and the tests implement them in memory.
 *
 * The split is not ceremony: it is the reason `__tests__` can assert that a failed logout still
 * wipes the refresh token, on CI, with no device attached.
 *
 * ── THE TWO ARE DELIBERATELY DIFFERENT TYPES ────────────────────────────────
 * A single `Storage` interface with one implementation choice would eventually put a token in the
 * wrong place — the call site cannot see which backing store it got. Two named types make
 * "refresh token" and "which branch was I in" impossible to confuse, and the lint rule in
 * `eslint.config.mjs` stops anyone reaching past them.
 */

/**
 * Hardware-backed storage: iOS Keychain, Android Keystore. Small values only.
 *
 * **The refresh token and nothing else.** Not the access token (memory only, M0 §5), not PHI, not
 * a cache. Reads can fail on a locked device, so every method may reject and callers must treat a
 * rejection as "no credential" rather than crashing.
 */
export interface SecureStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Ordinary unencrypted storage for things that are not secrets: which hospital, which branch was
 * last active, theme choice. Losing or leaking any of these is inconvenient, not dangerous —
 * which is exactly the test for whether something belongs here rather than above.
 */
export interface Preferences {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The device's own "prove it is you" (M2 K) — Touch ID / Face ID / fingerprint / device passcode.
 *
 * A third port for the same reason as the other two: `expo-local-authentication` is a native
 * module, and the lock policy is exactly the part that must be proven by a test rather than by
 * trying it on a phone. `src/platform/biometrics.ts` implements it; the tests implement it in
 * memory and can therefore make a scan fail five times in a row on CI, which no simulator will do
 * on request.
 *
 * ── IT ANSWERS TO THE DEVICE, NOT TO THE SERVER ─────────────────────────────
 * Nothing here is authentication in the API's sense. The server has already decided who this is
 * and the session is already valid; this only decides whether the phone renders it. A successful
 * scan is worth precisely as much as the device's own lock screen — which, for the threat this
 * addresses (a doctor's unlocked phone put down on a ward), is exactly the right amount.
 */
export interface BiometricAuthenticator {
  /** Is there a sensor, and has anybody enrolled on it? Both, separately — see `lock.ts`. */
  capability(): Promise<{ hasHardware: boolean; isEnrolled: boolean }>;
  /**
   * Prompt. `reason` is shown by the OS and must say what is being unlocked, in the user's terms.
   *
   * Never rejects: every failure mode is a value, because the caller's job is to CLASSIFY the
   * outcome (`afterAttempt`) and a thrown error would arrive at a `catch` block that cannot tell
   * "the user pressed cancel" from "the sensor is locked out" — two outcomes with opposite
   * consequences for the attempt counter.
   */
  authenticate(reason: string): Promise<"success" | "failed" | "cancelled" | "unavailable">;
}

/**
 * Keys are namespaced by hospital profile, because one person may work at two hospitals and the
 * two sessions must not overwrite each other (M0 §6). A bare `refreshToken` key would mean signing
 * into Apollo silently signs you out of Fortis.
 */
export const storageKeys = {
  refreshToken: (slug: string): string => `medicore.${slug}.refreshToken`,
  activeBranch: (slug: string, userId: string): string => `medicore.${slug}.${userId}.branch`,
  profiles: "medicore.profiles",
  lastProfile: "medicore.profiles.last",
  theme: "medicore.theme",
  /**
   * Whether the screen lock is on, per hospital (M2 K). A PREFERENCE, not a secret: knowing a
   * phone has the gate switched on tells an attacker nothing they cannot learn by opening the app,
   * and a Keychain read is only possible while the device is unlocked — which is precisely the
   * condition the gate has to work under.
   */
  screenLock: (slug: string): string => `medicore.${slug}.screenLock`,
} as const;

/** An in-memory implementation of both ports. Used by tests; never shipped in a build. */
export function createMemoryStorage(): SecureStorage &
  Preferences & { snapshot(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    snapshot: () => new Map(map),
  };
}
