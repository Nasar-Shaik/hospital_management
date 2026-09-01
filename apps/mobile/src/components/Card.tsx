/**
 * The clinical surface: a bordered card, and the labelled section it usually sits in.
 *
 * Extracted from the settings screen's private copies because M2 adds a dozen more of them, and a
 * card whose padding is decided per screen is how a list stops looking like a list.
 */
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { radius, size, space, typography } from "../theme/tokens";

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  /** Supplying this makes the whole card the touch target — 48dp minimum, gloved hands. */
  onPress?: () => void;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const surface: ViewStyle = {
    backgroundColor: theme.colors.bgElevated,
    borderColor: theme.colors.border,
  };

  if (!onPress) return <View style={[styles.card, surface, style]}>{children}</View>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.card,
        styles.tappable,
        surface,
        { opacity: pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

export function SectionTitle({
  title,
  trailing,
}: {
  title: string;
  trailing?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      {/* `accessibilityRole="header"` is what lets a screen reader jump between sections rather
          than reading a long clinical page from the top every time. */}
      <Text
        accessibilityRole="header"
        style={[styles.sectionTitle, { color: theme.colors.fgMuted }]}
      >
        {title}
      </Text>
      {trailing ? (
        <Text style={[styles.trailing, { color: theme.colors.fgSubtle }]}>{trailing}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space[3], gap: space[2] },
  tappable: { minHeight: size.touchTarget, justifyContent: "center" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[2],
  },
  sectionTitle: { ...typography.label, textTransform: "uppercase", letterSpacing: 0.5 },
  trailing: { ...typography.caption },
});
