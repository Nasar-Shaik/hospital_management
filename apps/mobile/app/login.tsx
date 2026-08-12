/**
 * Sign in (M0 §5).
 *
 * ── THE MFA BRANCH CANNOT BE FORGOTTEN ──────────────────────────────────────
 * `login()` returns a UNION — a token pair, or a challenge — and `isMfaChallenge` is the narrowing
 * helper the client ships precisely so this screen cannot fall through to a home screen for a user
 * who has not finished authenticating. Handling only the happy shape would compile.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { isMfaChallenge } from "@medicore/api-client";
import { Screen } from "../src/components/Screen.js";
import { TextField } from "../src/components/TextField.js";
import { Button } from "../src/components/Button.js";
import { ErrorState } from "../src/components/StateView.js";
import { useProfile } from "../src/providers/ProfileProvider.js";
import { useRuntime } from "../src/providers/RuntimeProvider.js";
import { useTheme } from "../src/hooks/useTheme.js";
import { toUserMessage, type UserFacingError } from "../src/lib/net/errors.js";
import { deviceLabel } from "../src/platform/device.js";
import { space, typography } from "../src/theme/tokens.js";

export default function LoginScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const { profile, clear } = useProfile();

  const [email, setEmail] = useState(profile?.lastUserEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<UserFacingError | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await runtime.auth.signIn(email.trim(), password, deviceLabel());
      if (isMfaChallenge(result)) {
        // The password is discarded here, not carried to the next screen — the challenge token is
        // the only credential the second step needs.
        setPassword("");
        router.push({ pathname: "/mfa", params: { mfaToken: result.mfaToken } });
        return;
      }
      setPassword("");
      router.replace("/");
    } catch (caught) {
      setError(toUserMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.fill}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.fg }]}>Sign in</Text>
            <Text style={[styles.subtitle, { color: theme.colors.fgMuted }]}>
              {profile?.label ?? "MediCore"}
            </Text>
          </View>

          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            errors={error?.fields?.email}
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            errors={error?.fields?.password}
          />

          <Button label="Sign in" onPress={() => void submit()} loading={busy} />

          {/* A field-level failure is already rendered on the inputs; only the rest needs a banner. */}
          {error && !error.fields ? (
            <View style={styles.error}>
              <ErrorState error={error} />
            </View>
          ) : null}

          <Button
            label="Use a different hospital"
            variant="secondary"
            onPress={() => {
              clear();
              router.replace("/hospital");
            }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { gap: space[4], paddingBottom: space[8] },
  header: { gap: space[1], marginBottom: space[4] },
  title: { ...typography.title },
  subtitle: { ...typography.body },
  error: { minHeight: 140 },
});
