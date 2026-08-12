import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { space, typography } from "../theme/tokens";

/**
 * What the app switcher gets to photograph (M0 §15).
 *
 * iOS takes a snapshot of the last frame when the app leaves the foreground, and that image sits
 * in the multitasking switcher — a public surface, visible to anyone who picks the phone up. If
 * the last frame was a patient record, the record is now in the switcher.
 *
 * A SOLID cover, not a blur: a blurred medication list is still recognisable, and a blur radius is
 * a guess about how much information survives it. There is no guessing here.
 */
export function PrivacyOverlay(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: theme.colors.bg }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.mark, { color: theme.colors.brandStrong }]}>MediCore</Text>
      <Text style={[styles.note, { color: theme.colors.fgSubtle }]}>
        Hidden while in background
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { alignItems: "center", justifyContent: "center", gap: space[2], zIndex: 1000 },
  mark: { ...typography.title },
  note: { ...typography.caption },
});
