/**
 * The signed-in shell: a tab bar built from the permission set (M0 §8).
 *
 * ── EVERY TAB IS DECLARED; VISIBILITY IS THE VARIABLE ───────────────────────
 * Expo Router's file system defines the routes, so all six screens exist whatever the user holds —
 * a deep link to `/pharmacy` must resolve rather than 404, and then be refused properly. What
 * `tabsFor` decides is which ones appear in the BAR. The screen itself re-checks, and the server
 * refuses regardless: the UI hides, it does not enforce.
 */
import { useEffect } from "react";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Link, Redirect, Tabs } from "expo-router";
import { requireRuntime, useRuntime } from "../../src/providers/RuntimeProvider";
import { useCapabilities, useSession } from "../../src/hooks/useStores";
import { useTheme } from "../../src/hooks/useTheme";
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
  );
}

export default requireRuntime(AppLayout);
