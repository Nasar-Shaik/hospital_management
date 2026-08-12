/**
 * Settings: who you are, where you are working, how it looks, and how to get out.
 *
 * The About block carries `API_VERSION` and the build number deliberately (M0 §17): when a
 * `Sunset` header eventually arrives, the only useful question is which builds are still calling
 * the retired operation, and the answer has to be readable off a phone in a ward.
 */
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { API_VERSION } from "@medicore/api-client";
import { useStore } from "zustand";
import { Screen } from "../../src/components/Screen";
import { Button } from "../../src/components/Button";
import { useRuntime } from "../../src/providers/RuntimeProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { useActiveBranchLabel, useConnectivity, useSession } from "../../src/hooks/useStores";
import { themeStore, useTheme } from "../../src/hooks/useTheme";
import { splitTabs } from "../../src/navigation/tabsFor";
import { appConfig, appVersion } from "../../src/platform/config";
import type { ThemePreference } from "../../src/state/theme";
import { space, typography } from "../../src/theme/tokens";
import { ScreenLockSetting } from "../../src/components/ScreenLockSetting";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const { profile, clear } = useProfile();

  const user = useSession((s) => s.user);
  const permissions = useSession((s) => s.permissions);
  const permissionCount = permissions.size;

  /**
   * The bar holds five (M0 §8), so a user entitled to more loses the surplus. `splitTabs` has
   * always returned it; until now nothing rendered it, which meant an administrator holding every
   * grant simply could not open Billing from the app. This is the "More" the tab bar promises.
   */
  const { overflow } = splitTabs(permissions);
  const branchLabel = useActiveBranchLabel();
  const online = useConnectivity((s) => s.online);
  const preference = useStore(themeStore, (s) => s.preference);

  const signOut = async (): Promise<void> => {
    // Resolves once the LOCAL wipe is done, whatever the network did (M0 §5). Navigation happens
    // through `onSessionEnded`, so every sign-out path — this one, an expiry, a revocation —
    // leaves by the same door.
    await runtime.auth.signOut();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body}>
        <Section title="Signed in as">
          <Row label={user?.name ?? "—"} value={user?.email ?? ""} />
          <Row label="Roles" value={user?.roles.join(", ") || "none"} />
          <Row label="Permissions" value={`${String(permissionCount)} granted`} />
        </Section>

        <Section title="Working at">
          <Row label={profile?.label ?? "—"} value={branchLabel} />
          <Button
            label="Change branch"
            variant="secondary"
            onPress={() => router.push("/branch")}
          />
        </Section>

        {overflow.length > 0 ? (
          <Section title="More">
            {overflow.map((tab) => (
              <Button
                key={tab.name}
                label={tab.title}
                variant="secondary"
                onPress={() => router.push(`/${tab.name}`)}
              />
            ))}
          </Section>
        ) : null}

        <Section title="Appearance">
          <View style={styles.options}>
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                label={option.label}
                variant={preference === option.value ? "primary" : "secondary"}
                onPress={() => themeStore.getState().setPreference(option.value)}
              />
            ))}
          </View>
        </Section>

        <Section title="Security">
          <ScreenLockSetting />
        </Section>

        <Section title="About">
          <Row label="App version" value={appVersion} />
          <Row label="API version" value={API_VERSION} />
          <Row label="Environment" value={appConfig.environment} />
          <Row label="Connection" value={online ? "Reachable" : "Not reachable"} />
        </Section>

        <View style={styles.exit}>
          <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
          <Button
            label="Switch hospital"
            variant="secondary"
            onPress={() => {
              // Sign out FIRST: leaving a live session behind on a profile the user has walked
              // away from is how a token outlives the intent to use it.
              void signOut().then(() => {
                clear();
                router.replace("/hospital");
              });
            }}
          />
        </View>

        <Text style={[styles.footnote, { color: theme.colors.fgSubtle }]}>
          Signing out always completes on this device, even with no connection. Other devices stay
          signed in until they are signed out themselves.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.fgMuted }]}>{title}</Text>
      <View
        style={[
          styles.card,
          { backgroundColor: theme.colors.bgSubtle, borderColor: theme.colors.border },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.colors.fg }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.colors.fgMuted }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[6], paddingBottom: space[8] },
  section: { gap: space[2] },
  sectionTitle: { ...typography.label, textTransform: "uppercase" },
  card: { borderWidth: 1, borderRadius: 12, padding: space[3], gap: space[3] },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space[3] },
  rowLabel: { ...typography.body, flexShrink: 0 },
  rowValue: { ...typography.body, flexShrink: 1, textAlign: "right" },
  options: { gap: space[2] },
  exit: { gap: space[2] },
  footnote: { ...typography.caption },
});
