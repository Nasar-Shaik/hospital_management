/**
 * The root layout: providers, the session gate, and the privacy overlay.
 *
 * ── THE ORDER OF THE GATES IS THE SECURITY MODEL ────────────────────────────
 *   1. Which hospital?      → without it there is no base URL and no runtime.
 *   2. Is there a session?  → `resume()` exchanges a stored refresh token; a cold start costs one
 *                             round trip because the access token is never persisted (M0 §5).
 *   3. Only then, the app.
 *
 * Each gate renders a splash rather than a login screen while it is deciding. Showing "Sign in"
 * for the half-second before `resume()` answers would teach returning users to start typing.
 */
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ProfileProvider, useProfile } from "../src/providers/ProfileProvider";
import { RuntimeProvider, useOptionalRuntime } from "../src/providers/RuntimeProvider";
import { PrivacyCover } from "../src/components/PrivacyOverlay";
import { useTheme } from "../src/hooks/useTheme";
import type { MobileRuntime } from "../src/lib/runtime";
import type { SessionEndReason } from "../src/lib/session";

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ProfileProvider>
        <WithRuntime />
      </ProfileProvider>
    </SafeAreaProvider>
  );
}

function WithRuntime(): React.JSX.Element {
  const { profile, ready } = useProfile();
  const router = useRouter();

  /**
   * Every path out of a session lands here: expiry, revocation, and the user's own sign-out. One
   * navigation, so no caller can forget it, and `dismissAll` first because a modal left open over
   * the login screen would be a PHI screen sitting on top of an unauthenticated one.
   *
   * `canDismiss` is not defensive padding. A cold start whose stored refresh token has expired
   * ends the session from inside `resume()`, which can resolve before the navigator has a stack to
   * pop — and an unguarded `dismissAll` there throws over the top of an ordinary, expected expiry.
   */
  const onSessionEnded = useCallback(
    (_reason: SessionEndReason) => {
      if (router.canDismiss()) router.dismissAll();
      router.replace("/login");
    },
    [router],
  );

  if (!ready) return <Splash />;

  return (
    <RuntimeProvider profile={profile} onSessionEnded={onSessionEnded}>
      <Shell />
    </RuntimeProvider>
  );
}

function Shell(): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      <SessionBootstrap />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.bg },
        }}
      />
      <PrivacyCover />
    </>
  );
}

/**
 * Runs `resume()` once per runtime and routes on the answer. Split into its own component so it
 * sits INSIDE the runtime provider while the navigator above it stays mounted throughout.
 *
 * It does NOT handle the no-hospital case. Sending the user to `/hospital` is a render-time
 * decision belonging to `requireRuntime`, because the screen that needs sending has already
 * thrown by the time an effect runs.
 *
 * Keyed on the runtime OBJECT rather than the slug: leaving a hospital and returning to it builds
 * a fresh runtime with an empty session, and a slug key would remember the earlier attempt and
 * leave a user with a perfectly good refresh token stranded on the login screen.
 */
function SessionBootstrap(): null {
  const runtime = useOptionalRuntime();
  const router = useRouter();
  const attempted = useRef<MobileRuntime | undefined>(undefined);

  useEffect(() => {
    if (!runtime || attempted.current === runtime) return;
    attempted.current = runtime;

    void (async () => {
      const restored = await runtime.auth.resume();
      // `resume()` already signed the session out on failure, which fires `onSessionEnded` and
      // navigates. Only the success path needs to move.
      if (restored) router.replace("/");
    })();
  }, [runtime, router]);

  return null;
}

function Splash(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.splash, { backgroundColor: theme.colors.bg }]}>
      <ActivityIndicator color={theme.colors.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center" },
});
