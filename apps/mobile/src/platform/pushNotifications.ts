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
 * ── THE PROJECT ID IS A REAL PREREQUISITE ───────────────────────────────────
 * `extra.eas.projectId` is not set in this repository, because no EAS project has been linked yet.
 * Until it is, `getExpoPushTokenAsync` throws and this returns undefined — which is the correct
 * behaviour and also means push CANNOT be validated on hardware until the project is linked. That
 * is recorded as a BLOCKER in `MOBILE_M4_DEVICE_CHECKLIST.md` rather than hidden behind a silent
 * fallback that looks like it works.
 */
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  readPayload,
  type PushCredential,
  type PushPayload,
  type PushRegistrar,
} from "../lib/push";

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
      if (!platform) return undefined;

      /**
       * Android needs a channel before a notification can be shown at all, and the channel is
       * what carries importance — a HIGH channel is what gets a critical result past Doze. It is
       * created here rather than in a config plugin so the one place that owns push owns all of
       * it, and so the value cannot drift from the `priority` the server sends.
       */
      if (platform === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "Alerts",
          importance: Notifications.AndroidImportance.HIGH,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
      if (!granted) return undefined;

      const id = projectId();
      if (!id) return undefined;

      const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
      return token.data ? { token: token.data, platform } : undefined;
    } catch {
      // A simulator, Expo Go, a revoked permission, a network failure at APNs. All the same
      // answer: this phone will not buzz, and nothing else changes.
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
