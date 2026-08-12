/**
 * Loading, error and empty — the three states every data screen has, rendered the same way.
 *
 * ── WHY THEY ARE ONE COMPONENT ──────────────────────────────────────────────
 * Left to each screen, the loading state becomes a spinner in one place and a skeleton in another,
 * the empty state becomes an accidental blank page, and the error state becomes `err.message` on
 * screen — which is how a raw traceId, or a server string quoting a request body, reaches a user.
 *
 * The error variant takes a `UserFacingError` and nothing else. There is no prop that accepts a
 * raw exception, so a screen cannot render one even in a hurry.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme.js";
import { radius, size, space, typography } from "../theme/tokens.js";
import type { UserFacingError } from "../lib/net/errors.js";

export function LoadingState({ label = "Loading…" }: { label?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.centre} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={theme.colors.brand} />
      <Text style={[styles.body, { color: theme.colors.fgMuted }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.centre}>
      <Text style={[styles.title, { color: theme.colors.fg }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: theme.colors.fgMuted }]}>{body}</Text> : null}
    </View>
  );
}

const ACTION_LABELS: Record<NonNullable<UserFacingError["action"]>, string> = {
  retry: "Try again",
  reload: "Reload",
  signIn: "Sign in",
  pickBranch: "Choose a branch",
  contactAdmin: "OK",
};

export function ErrorState({
  error,
  onAction,
}: {
  error: UserFacingError;
  onAction?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const tone = error.severity === "blocking" ? theme.colors.danger : theme.colors.fgMuted;

  return (
    <View style={styles.centre} accessibilityRole="alert">
      <Text style={[styles.title, { color: theme.colors.fg }]}>{error.title}</Text>
      <Text style={[styles.body, { color: tone }]}>{error.body}</Text>

      {error.action && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.action,
            {
              backgroundColor: theme.colors.brandStrong,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Text style={[styles.actionLabel, { color: theme.colors.onAccent }]}>
            {ACTION_LABELS[error.action]}
          </Text>
        </Pressable>
      ) : null}

      {/**
       * The traceId is the ONLY diagnostic shown, and only in the muted footer. It resolves to the
       * full server-side record for anyone with API access and to nothing for anyone else — which
       * is exactly the property that makes it safe to put in front of a user (M0 §15).
       */}
      {error.traceId ? (
        <Text style={[styles.trace, { color: theme.colors.fgSubtle }]} selectable>
          Reference {error.traceId}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space[2],
    padding: space[6],
  },
  title: { ...typography.heading, textAlign: "center" },
  body: { ...typography.body, textAlign: "center" },
  action: {
    minHeight: size.touchTarget,
    paddingHorizontal: space[6],
    justifyContent: "center",
    borderRadius: radius.md,
    marginTop: space[2],
  },
  actionLabel: { ...typography.label },
  trace: { ...typography.caption, marginTop: space[4] },
});
