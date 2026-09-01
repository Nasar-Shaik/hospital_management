/**
 * A status badge, and the one badge that is allowed to shout.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ─────────────────────────────────────────
 * Around 1 in 12 men has a colour vision deficiency, and a phone in a corridor is read at a glance
 * and at an angle. Every pill therefore carries its own WORD — "Waiting", "CRITICAL" — and the tone
 * only reinforces it. A dot, a tint or a coloured left border on its own would be a status that
 * some of the intended readers cannot see.
 */
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { radius, space, typography } from "../theme/tokens";
import { toneColors } from "../theme/tone";
import type { ClinicalTone } from "../clinical/encounters";

export function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: ClinicalTone;
}): React.JSX.Element {
  const theme = useTheme();
  const colors = toneColors(theme, tone);
  return (
    <View style={[styles.pill, { backgroundColor: colors.bg }]}>
      <Text style={[styles.label, { color: colors.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The critical-result marker.
 *
 * Deliberately not a `Pill` with `tone="critical"`: this one is filled rather than tinted, so it
 * still reads as an alarm in bright ward lighting where a pale wash disappears. It is also given an
 * `alert` role, which is what makes a screen reader announce it rather than wait to be asked.
 */
export function CriticalFlag({ label = "CRITICAL" }: { label?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.pill, styles.critical, { backgroundColor: theme.colors.criticalClinical }]}
    >
      <Text style={[styles.label, styles.criticalLabel, { color: theme.colors.bg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: space[2],
    paddingVertical: space[1],
    borderRadius: radius.sm,
    alignSelf: "flex-start",
  },
  label: { ...typography.caption, fontWeight: "600" },
  critical: { paddingHorizontal: space[2] },
  criticalLabel: { letterSpacing: 0.5 },
});
