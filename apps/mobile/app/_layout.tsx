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
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ProfileProvider, useProfile } from "../src/providers/ProfileProvider.js";
import { RuntimeProvider, useOptionalRuntime } from "../src/providers/RuntimeProvider.js";
import { useAppLifecycle } from "../src/hooks/useAppLifecycle.js";
import { PrivacyOverlay } from "../src/components/PrivacyOverlay.js";
import { useTheme } from "../src/hooks/useTheme.js";
import type { SessionEndReason } from "../src/lib/session.js";

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
   */
  const onSessionEnded = useCallback(
    (_reason: SessionEndReason) => {
      router.dismissAll();
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
      <Obscure />
    </>
  );
}

/**
 * Runs `resume()` once per runtime and routes on the answer. Split into its own component so it
 * sits INSIDE the runtime provider while the navigator above it stays mounted throughout.
 */
function SessionBootstrap(): null {
  const runtime = useOptionalRuntime();
  const { profile, ready } = useProfile();
  const router = useRouter();
  const [attempted, setAttempted] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!ready) return;

    if (!profile) {
      router.replace("/hospital");
      return;
    }
    if (!runtime || attempted === profile.slug) return;
    setAttempted(profile.slug);

    void (async () => {
      const restored = await runtime.auth.resume();
      // `resume()` already signed the session out on failure, which fires `onSessionEnded` and
      // navigates. Only the success path needs to move.
      if (restored) router.replace("/");
    })();
  }, [ready, profile, runtime, router, attempted]);

  return null;
}

/** The app-switcher cover. Mounted at the root so no screen can be missed. */
function Obscure(): React.JSX.Element | null {
  const runtime = useOptionalRuntime();
  return runtime ? <ObscureWithLifecycle /> : null;
}

function ObscureWithLifecycle(): React.JSX.Element | null {
  const { obscured } = useAppLifecycle();
  return obscured ? <PrivacyOverlay /> : null;
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
