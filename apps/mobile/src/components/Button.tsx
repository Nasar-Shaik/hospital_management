import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme.js";
import { radius, size, space, typography } from "../theme/tokens.js";

/**
 * ── A DISABLED BUTTON MUST SAY WHY ──────────────────────────────────────────
 * `reason` is not decoration. A greyed-out Save with no explanation is the single most common
 * complaint about clinical software: the user cannot tell whether they lack permission, are
 * offline, or have not picked a branch, so they try three times and then telephone someone. The
 * write guard computes the reason (`src/lib/guard.ts`); this renders it, and does so as an
 * accessibility hint too, so a screen reader reaches it.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  reason,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  reason?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const inert = disabled || loading;

  const background =
    variant === "primary"
      ? theme.colors.brandStrong
      : variant === "danger"
        ? theme.colors.danger
        : "transparent";
  const foreground = variant === "secondary" ? theme.colors.fg : theme.colors.onAccent;

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        disabled={inert}
        accessibilityRole="button"
        accessibilityState={{ disabled: inert, busy: loading }}
        accessibilityHint={inert ? reason : undefined}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: background,
            borderColor: variant === "secondary" ? theme.colors.borderStrong : "transparent",
            opacity: inert ? 0.5 : pressed ? 0.85 : 1,
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={foreground} />
        ) : (
          <Text style={[styles.label, { color: foreground }]}>{label}</Text>
        )}
      </Pressable>

      {inert && reason ? (
        <Text style={[styles.reason, { color: theme.colors.fgMuted }]}>{reason}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: space[1] },
  button: {
    minHeight: size.touchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space[4],
  },
  label: { ...typography.label },
  reason: { ...typography.caption, paddingHorizontal: space[1] },
});
