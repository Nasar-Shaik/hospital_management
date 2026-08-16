/**
 * The signed-in shell: a tab bar built from the permission set (M0 §8).
 *
 * ── EVERY TAB IS DECLARED; VISIBILITY IS THE VARIABLE ───────────────────────
 * Expo Router's file system defines the routes, so all six screens exist whatever the user holds —
 * a deep link to `/pharmacy` must resolve rather than 404, and then be refused properly. What
 * `tabsFor` decides is which ones appear in the BAR. The screen itself re-checks, and the server
 * refuses regardless: the UI hides, it does not enforce.
 */
import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Link, Redirect, Tabs } from "expo-router";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { requireRuntime, useRuntime } from "../../src/providers/RuntimeProvider";
import { useCapabilities, useSession } from "../../src/hooks/useStores";
import { useTheme } from "../../src/hooks/useTheme";
import { useLicenceNotice } from "../../src/hooks/useLicenceNotice";
import { LicenceNotice } from "../../src/components/LicenceNotice";
import { TABS, splitTabs } from "../../src/navigation/tabsFor";

/**
 * `requireRuntime` covers every screen in the group, because a layout renders before its children.
 * `/` resolves here on a fresh install, so this is the guard that has to hold first.
 */
function AppLayout(): React.JSX.Element {
  const theme = useTheme();
  const runtime = useRuntime();
  const status = useSession((s) => s.status);
  const permissions = useSession((s) => s.permissions);
  const { ready } = useCapabilities();

  /**
   * ── WHO OWNS THE STATUS-BAR INSET, AND WHY IT CAN ONLY BE ONE OF THEM ───────
   * `LicenceNotice` sits above the navigator, so when it is showing IT is the thing at the top of
   * the window and it pads itself past the notch. React Navigation reads this context and would
   * otherwise pad its header by the same amount again, leaving a status-bar-sized gap between the
   * banner and the title. Handing the navigator a zeroed top while the banner is up makes the two
   * agree, and the ternary keeps a healthy licence — almost every day — exactly as it was.
   */
  const insets = useSafeAreaInsets();
  const notice = useLicenceNotice();
  const belowNotice = useMemo(() => (notice ? { ...insets, top: 0 } : insets), [insets, notice]);

  /**
   * A branch-shaped refusal anywhere in the app means the list this phone is holding is out of
   * date (M0 §7). Re-reading it here, once, keeps that recovery out of every individual screen.
   */
  useEffect(() => {
    if (!ready) return;
    const userId = runtime.session.getState().user?.id;
    if (!userId) return;
    if (!runtime.branch.getState().validated) void runtime.branches.restore(userId);
  }, [ready, runtime]);

  if (status === "signedOut") return <Redirect href="/login" />;

  const { visible } = splitTabs(permissions);
  const shown = new Set(visible.map((tab) => tab.name));

  return (
    /**
     * The licence warning sits ABOVE the navigator rather than inside a screen (M2 L): it is a
     * fact about the hospital, not about whatever the doctor is looking at, and a banner that
     * appeared only on the home tab would be missed by everyone who deep-links into a chart.
     *
     * It renders `null` for a healthy licence, so this wrapper costs nothing on almost every day.
     */
    <View style={styles.shell}>
      <LicenceNotice />
      <SafeAreaInsetsContext.Provider value={belowNotice}>
        <Tabs
          screenOptions={{
            headerShown: true,
            tabBarActiveTintColor: theme.colors.brandStrong,
            tabBarInactiveTintColor: theme.colors.fgSubtle,
            tabBarStyle: {
              backgroundColor: theme.colors.bgElevated,
              borderTopColor: theme.colors.border,
            },
            headerStyle: { backgroundColor: theme.colors.bgElevated },
            headerTintColor: theme.colors.fg,
            sceneStyle: { backgroundColor: theme.colors.bg },
            headerRight: () => (
              <Link href="/settings" asChild>
                <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={12}>
                  <Ionicons name="settings-outline" size={22} color={theme.colors.fgMuted} />
                </Pressable>
              </Link>
            ),
          }}
        >
          {/* The role home. Never in the bar — it only redirects. */}
          <Tabs.Screen name="index" options={{ href: null, headerShown: false }} />

          {TABS.map((tab) => (
            <Tabs.Screen
              key={tab.name}
              name={tab.name}
              options={{
                title: tab.title,
                // `href: null` keeps the ROUTE reachable while removing it from the bar, which is
                // exactly the distinction between hiding and forbidding.
                href: shown.has(tab.name) ? undefined : null,
                tabBarIcon: ({ color, size }) => (
                  <Ionicons name={tab.icon as never} size={size} color={color} />
                ),
              }}
            />
          ))}

          {/* Reachable from the header, never from the bar — five tabs is the ceiling (M0 §8). */}
          <Tabs.Screen name="settings" options={{ title: "Settings", href: null }} />
          <Tabs.Screen name="branch" options={{ title: "Branch", href: null }} />
        </Tabs>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The navigator still owns everything below the banner, so it needs the remaining height. */
  shell: { flex: 1 },
});

export default requireRuntime(AppLayout);
