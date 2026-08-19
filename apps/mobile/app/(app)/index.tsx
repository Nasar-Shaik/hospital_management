/**
 * The role home — a redirect, not a screen (M0 §8).
 *
 * This is the ONLY place a role name is read, and it decides nothing about access: a doctor lands
 * on the queue and a cashier on billing because that is where their day starts. An unknown or
 * renamed role falls through to the first tab the user can actually see, so a hospital that
 * invents its own role gets somewhere sensible rather than a blank screen.
 */
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useSession } from "../../src/hooks/useStores";
import { useTheme } from "../../src/hooks/useTheme";
import { homeFor } from "../../src/navigation/tabsFor";

export default function Home(): React.JSX.Element {
  const theme = useTheme();
  const status = useSession((s) => s.status);
  /**
   * The `?? []` belongs HERE, not in the selector.
   *
   * `useStore` is `useSyncExternalStore`, which compares snapshots with `Object.is` and re-renders
   * when they differ. A selector ending `?? []` mints a fresh array on every call, so it never
   * equals the last one: React re-renders, re-reads, gets another new array, and spins until it
   * gives up with "Maximum update depth exceeded". A selector must return something already in the
   * store, or a primitive — never a value it constructs.
   */
  const roles = useSession((s) => s.user?.roles);
  const permissions = useSession((s) => s.permissions);
  /** The hospital's edition (M4) — a tab for a module it never bought is a dead end. */
  const features = useSession((s) => s.features);

  if (status === "signedOut") return <Redirect href="/login" />;

  // Still bootstrapping: permissions arrive with `/auth/me`, and redirecting before they do would
  // send everyone to the same fallback tab for a frame.
  if (status === "unknown") {
    return (
      <View style={[styles.centre, { backgroundColor: theme.colors.bg }]}>
        <ActivityIndicator color={theme.colors.brand} />
      </View>
    );
  }

  const home = homeFor(roles ?? [], permissions, features);
  return <Redirect href={`/${home ?? "alerts"}`} />;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
});
