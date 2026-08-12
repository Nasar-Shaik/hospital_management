/**
 * The second factor.
 *
 * Reached only from the login screen, and only with a challenge token. The token is the credential
 * here — the password was discarded on the previous screen, so nothing sensitive is carried in a
 * navigation parameter.
 */
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "../src/components/Screen";
import { TextField } from "../src/components/TextField";
import { Button } from "../src/components/Button";
import { ErrorState } from "../src/components/StateView";
import { requireRuntime, useRuntime } from "../src/providers/RuntimeProvider";
import { useTheme } from "../src/hooks/useTheme";
import { toUserMessage, type UserFacingError } from "../src/lib/net/errors";
import { space, typography } from "../src/theme/tokens";

function MfaScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const { mfaToken } = useLocalSearchParams<{ mfaToken: string }>();

  const [code, setCode] = useState("");
  const [error, setError] = useState<UserFacingError | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!mfaToken) {
      router.replace("/login");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await runtime.auth.completeMfa(mfaToken, code.trim());
      router.replace("/");
    } catch (caught) {
      setError(toUserMessage(caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.colors.fg }]}>Verification</Text>
        <Text style={[styles.subtitle, { color: theme.colors.fgMuted }]}>
          Enter the six-digit code from your authenticator app.
        </Text>
      </View>

      <TextField
        label="Code"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={8}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        hint="A recovery code also works here."
      />

      <Button label="Verify" onPress={() => void submit()} loading={busy} />
      {error ? (
        <View style={styles.error}>
          <ErrorState error={error} />
        </View>
      ) : null}
    </Screen>
  );
}

export default requireRuntime(MfaScreen);

const styles = StyleSheet.create({
  header: { gap: space[1] },
  title: { ...typography.title },
  subtitle: { ...typography.body },
  error: { minHeight: 140 },
});
