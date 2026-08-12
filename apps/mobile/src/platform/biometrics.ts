/**
 * The device's biometric prompt: Touch ID, Face ID, Android fingerprint (M2 K).
 *
 * This is the third file permitted to import a native module directly (see the lint rule in
 * `eslint.config.mjs`), alongside `secureStore.ts` and `preferences.ts`. Everything else depends
 * on the `BiometricAuthenticator` interface — which is what lets the lock tests fail a scan five
 * times in a row on CI, something no simulator will do on request.
 *
 * ── EXPO GO: THE EARLIER ASSUMPTION WAS WRONG ───────────────────────────────
 * M2 J deferred K on the grounds that this module needs a development build. The evidence in the
 * installed package says otherwise for SDK 54: `expo-local-authentication@17.0.8` is listed in
 * Expo's own `bundledNativeModules.json`, and its Android publication is `host.exp.exponent` —
 * the Expo Go client's namespace. It ships INSIDE Expo Go, so no development build is required to
 * run this.
 *
 * That is evidence, not a device test, and the only conclusive check is a prompt on real hardware
 * — a simulator has no enrolled finger. The code does not depend on the answer either way: if the
 * module is ever absent, `capability()` returns no-hardware and `authenticate()` returns
 * `unavailable`, so the gate still goes up and the password path still opens. Degrading, never
 * crashing, was the design goal precisely because this question could not be settled on CI.
 *
 * ── FALLING BACK TO THE DEVICE PASSCODE IS DELIBERATE ───────────────────────
 * `disableDeviceFallback: false` lets the OS offer "Enter Passcode" when a face or finger will not
 * read. That is the behaviour a doctor expects from every other app on the phone, and refusing it
 * would send somebody with a bandaged thumb to the app's own password screen — a round trip to the
 * network, on a ward, to see a chart the phone already has.
 */
import * as LocalAuthentication from "expo-local-authentication";
import type { BiometricAuthenticator } from "../lib/storage";
import { classifyError } from "../lib/lock";

export const biometrics: BiometricAuthenticator = {
  async capability() {
    try {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return { hasHardware, isEnrolled };
    } catch {
      /**
       * A device or a runtime that cannot answer is treated as having nothing. The lock still goes
       * up — capability decides the METHOD, never whether to lock (`lock.ts`) — and the user is
       * sent to the password path, which always works.
       */
      return { hasHardware: false, isEnrolled: false };
    }
  },

  async authenticate(reason) {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        // The app's own password screen is the fallback of last resort; the OS passcode is better.
        disableDeviceFallback: false,
        cancelLabel: "Use password",
      });

      if (result.success) return "success";

      // The mapping is POLICY, not plumbing: `user_cancel` in the wrong bucket means five dismissed
      // prompts sign a doctor out. `classifyError` lives in `src/lib` so it can be tested
      // exhaustively without a device — see the note there.
      return classifyError(result.error);
    } catch {
      // The module is missing, or the call threw. Not the user's fault, so not a failure — and not
      // an unlock either: `unavailable` opens the password door and charges no attempt.
      return "unavailable";
    }
  },
};
