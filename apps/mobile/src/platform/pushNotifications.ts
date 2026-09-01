/**
 * The device's notification service — Expo Push over APNs and FCM (M4).
 *
 * The FOURTH file permitted to import a native module directly (see the lint rule in
 * `eslint.config.mjs`), alongside `secureStore.ts`, `preferences.ts` and `biometrics.ts`.
 * Everything else depends on the `PushRegistrar` interface, which is what lets the registration
 * lifecycle, the payload parsing and the deep-link mapping be tested on CI with no device.
 *
 * ── EVERY FAILURE HERE IS A SHRUG, NOT AN ERROR ─────────────────────────────
 * Four ordinary situations produce no token, and all four are phones that work perfectly:
 *
 *   a simulator            has no push hardware at all
 *   Expo Go                dropped remote push in SDK 53 — a development build is required
 *   a declined permission  the user said no, which is their right
 *   no EAS project id      `getExpoPushTokenAsync` cannot mint one without it (see app.config.ts)
 *
 * None of them may throw, and none of them may degrade anything: the in-app inbox is the message
 * and is unaffected. The whole file therefore returns `undefined` rather than reporting a problem,
 * which is also why the app has no "push is broken" state to design.
 *
 * ── THE PROJECT ID IS A REAL PREREQUISITE, AND AN EXTERNAL ONE ──────────────
 * `extra.eas.projectId` is plumbed through `app.config.ts` from either `app.json` or
 * `EAS_PROJECT_ID`, and is populated by neither until somebody runs `eas init` against a real Expo
 * account. Until then `getExpoPushTokenAsync` is never reached, this returns undefined, and no
 * device registers — correct behaviour, and also the reason push cannot be validated on hardware
 * yet. `AI_Workflow/docs/MOBILE_PUSH_ENABLEMENT.md` is the runbook; the blocker is recorded in
 * `MOBILE_M4_DEVICE_CHECKLIST.md` rather than hidden behind a fallback that looks like it works.
 */
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { PUSH_CHANNEL } from "@medicore/types";
import {
  readPayload,
  type PushCredential,
  type PushPayload,
  type PushRegistrar,
} from "../lib/push";
import { createLogger } from "../lib/log";
import { appConfig } from "./config";

/**
 * ── WHY THE ONLY PLATFORM FILE THAT LOGS ────────────────────────────────────
 * Four ordinary situations produce no token and the app must react to none of them, so the
 * function returns `undefined` and the user is told nothing. Correct in the app; useless on the
 * bench. A tester holding a phone that never buzzes needs to distinguish "no EAS project" from
 * "the user declined" from "this is Expo Go", and there is no other way to see it — the whole
 * reason M4 shipped without a single device check is a silence exactly like this one.
 *
 * `debug`, so it is dropped entirely in a release build (see `createLogger`). It names a REASON
 * and nothing else — no token, ever: an Expo push token is a bearer address for a person's phone.
 */
const logger = createLogger({ verbose: appConfig.environment !== "production" });

/**
 * Show the banner even while the app is open.
 *
 * A doctor looking at a ward list when a critical potassium arrives is exactly the person the
 * alert is for, and the default behaviour — suppress it, because the app is in the foreground —
 * is the one case where suppressing it is most obviously wrong.
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export const pushNotifications: PushRegistrar = {
  async getCredential(): Promise<PushCredential | undefined> {
    try {
      const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
      // Web and anything else Expo grows: no push address, no registration, no complaint.
      if (!platform) {
        logger.debug("push unavailable", { code: "unsupported-platform" });
        return undefined;
      }

      /**
       * ── TWO CHANNELS, BECAUSE ONE MADE EVERYTHING URGENT (K4-01) ──────────
       * Android needs a channel before a notification can be shown at all, and on Android 8+ the
       * CHANNEL — not the message's priority — decides whether something interrupts a human. A
       * single HIGH channel therefore made a routine released result buzz, light the screen and
       * talk over a ward round exactly like a critical potassium. A ward that is interrupted by
       * everything learns to ignore the phone, which costs precisely the alert this feature
       * exists for.
       *
       * Both are created here rather than in a config plugin, so the one module that owns push
       * owns all of it — and both are created UNCONDITIONALLY, before any token is minted. A push
       * naming a channel the app has not created is not downgraded by Android, it is DISCARDED,
       * with an `ok` ticket from Expo and nothing in any log. Creating them lazily, or only the
       * one a given build expects to use, is how that happens.
       *
       * The ids come from `@medicore/types`, which is where the server reads them too.
       */
      if (platform === "android") {
        await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.critical, {
          name: "Critical alerts",
          description: "Results and events that need attention now.",
          importance: Notifications.AndroidImportance.HIGH,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
        await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.routine, {
          name: "Alerts",
          description: "Everything else addressed to you.",
          // DEFAULT: it arrives, it waits, it does not take over the screen.
          importance: Notifications.AndroidImportance.DEFAULT,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
      if (!granted) {
        logger.debug("push unavailable", { code: "permission-denied" });
        return undefined;
      }

      const id = projectId();
      if (!id) {
        // The blocker M4 shipped with. `eas init`, or set EAS_PROJECT_ID — see app.config.ts.
        logger.debug("push unavailable", { code: "no-eas-project-id" });
        return undefined;
      }

      const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
      if (!token.data) {
        logger.debug("push unavailable", { code: "no-token-issued" });
        return undefined;
      }
      return { token: token.data, platform };
    } catch (err) {
      /**
       * A simulator, Expo Go (no remote push since SDK 53), a revoked permission, a network
       * failure at APNs. All the same answer to the app: this phone will not buzz, and nothing
       * else changes. The CLASS of the error is logged — never its message, which can quote a
       * request — because "which of these is it" is the first question on a bench.
       */
      logger.debug("push unavailable", {
        code: "registrar-threw",
        errorName: err instanceof Error ? err.name : "unknown",
      });
      return undefined;
    }
  },

  onOpened(handler: (payload: PushPayload) => void): () => void {
    /**
     * Two arrivals, one handler. A tap while the app is running fires the listener; a tap that
     * LAUNCHED the app fires nothing at all, and the payload is waiting in `getLastNotificationResponseAsync`.
     * Wiring only the listener is the classic half-implementation: it works in every test and
     * fails for exactly the case a push is for — a phone in a pocket, screen off.
     */
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handler(readPayload(response.notification.request.content.data));
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handler(readPayload(response.notification.request.content.data));
    });

    return () => subscription.remove();
  },
};
