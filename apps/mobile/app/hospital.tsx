/**
 * First launch: which hospital? (M0 §6)
 *
 * A slug, not a URL. Users type `apollo`, not `https://apollo.paperlesstech.in`, and the domain
 * comes from the build profile — which is also what stops a production binary being pointed at a
 * staging API by anyone who can type. A QR code the hospital prints is a later convenience on top
 * of this screen, not a replacement for it.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "../src/components/Screen";
import { TextField } from "../src/components/TextField";
import { Button } from "../src/components/Button";
import { useProfile } from "../src/providers/ProfileProvider";
import { useTheme } from "../src/hooks/useTheme";
import { createProfile, validateSlug, type SlugProblem } from "../src/lib/tenant";
import { appConfig } from "../src/platform/config";
import { space, typography } from "../src/theme/tokens";

const MESSAGES: Record<SlugProblem, string> = {
  empty: "Enter the code your hospital gave you.",
  format: "Use only letters, numbers and hyphens — for example, apollo-hyd.",
  reserved: "That code is reserved. Check it with your administrator.",
};

export default function HospitalScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { choose, known } = useProfile();
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<SlugProblem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (slug: string): Promise<void> => {
    const invalid = validateSlug(slug);
    setProblem(invalid);
    if (invalid) return;

    setBusy(true);
    try {
      await choose(
        createProfile(slug, {
          tenantDomain: appConfig.tenantDomain,
          insecureTransportAllowed: appConfig.insecureTransportAllowed,
        }),
      );
      router.replace("/login");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.fg }]}>MediCore</Text>
          <Text style={[styles.subtitle, { color: theme.colors.fgMuted }]}>
            Which hospital are you signing in to?
          </Text>
        </View>

        <TextField
          label="Hospital code"
          value={code}
          onChangeText={(next) => {
            setCode(next);
            setProblem(undefined);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="go"
          onSubmitEditing={() => void submit(code)}
          hint={`Your sign-in address will be ${code.trim().toLowerCase() || "…"}.${appConfig.tenantDomain}`}
          errors={problem ? [MESSAGES[problem]] : undefined}
        />

        <Button label="Continue" onPress={() => void submit(code)} loading={busy} />

        {known.length > 0 ? (
          <View style={styles.known}>
            <Text style={[styles.knownLabel, { color: theme.colors.fgMuted }]}>
              Hospitals on this device
            </Text>
            {known.map((profile) => (
              <Button
                key={profile.slug}
                label={profile.label}
                variant="secondary"
                onPress={() => void submit(profile.slug)}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[4], paddingBottom: space[8] },
  header: { gap: space[1], marginBottom: space[4] },
  title: { ...typography.title },
  subtitle: { ...typography.body },
  known: { gap: space[2], marginTop: space[6] },
  knownLabel: { ...typography.label },
});
