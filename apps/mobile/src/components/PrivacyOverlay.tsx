import { StyleSheet, Text, View } from "react-native";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import { useTheme } from "../hooks/useTheme";
import { requireRuntime } from "../providers/RuntimeProvider";
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

function CoverWhenBackgrounded(): React.JSX.Element | null {
  const { obscured } = useAppLifecycle();
  return obscured ? <PrivacyOverlay /> : null;
}

/**
 * The mounted form of the above: sits at the ROOT, above the navigator, so that no screen can
 * forget it and no new screen in M2 has to remember it.
 *
 * `useAppLifecycle` reads the runtime, and the root renders before a hospital is chosen — hence
 * the guard. It renders nothing rather than redirecting: there is no session and therefore no PHI
 * to hide on the one screen reachable without a runtime.
 */
export const PrivacyCover = requireRuntime(CoverWhenBackgrounded, null);

const styles = StyleSheet.create({
  cover: { alignItems: "center", justifyContent: "center", gap: space[2], zIndex: 1000 },
  mark: { ...typography.title },
  note: { ...typography.caption },
});
