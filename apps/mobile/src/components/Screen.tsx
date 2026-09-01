import { StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { useTheme } from "../hooks/useTheme";
import { space } from "../theme/tokens";

/**
 * The page frame: safe-area insets and the themed background, in one place.
 *
 * Every screen uses it, so nothing has to remember that a notch exists or that the background is
 * a token rather than white — and a theme change is one file rather than fifty.
 */
export function Screen({
  children,
  padded = true,
  edges = ["top", "bottom"],
  style,
}: {
  children: React.ReactNode;
  padded?: boolean;
  edges?: readonly Edge[];
  style?: ViewStyle;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeAreaView edges={edges} style={[styles.root, { backgroundColor: theme.colors.bg }, style]}>
      <View style={padded ? styles.padded : styles.flush}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  padded: { flex: 1, padding: space[4], gap: space[4] },
  flush: { flex: 1 },
});
