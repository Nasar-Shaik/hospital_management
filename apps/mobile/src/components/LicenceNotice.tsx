/**
 * The renewal warning (M2 L) — the hospital's subscription, said once, where a doctor will see it.
 *
 * ── IT WARNS; IT NEVER BLOCKS ───────────────────────────────────────────────
 * Both states it renders are states the server is still SERVING. `EXPIRING` is a heads-up, `GRACE`
 * is a countdown to the day access is actually cut, and neither stops anybody working — the write
 * guard's licence block is reserved for the refusal that has already happened (`lib/licence.ts`).
 *
 * Nothing is rendered for `ACTIVE`, and nothing for `EXPIRED` either: by then every screen is
 * already showing the blocking error, and a banner repeating it would read as a second, separate
 * problem.
 *
 * ── NOT DISMISSIBLE, UNLIKE THE WEB APP'S ───────────────────────────────────
 * The web banner can be closed because it sits on a desktop shell somebody has open all day. This
 * is two lines at the top of a phone, seen in glances between patients, and the person seeing it is
 * usually not the person who can act on it — so the value is that it is still there for whoever
 * next picks the phone up. It costs a fixed strip of screen for a handful of days per year.
 */
import { StyleSheet, Text, View } from "react-native";
import { useLicence } from "../hooks/useStores";
import { useTheme } from "../hooks/useTheme";
import { licenceNotice } from "../lib/licence";
import { space, typography } from "../theme/tokens";

export function LicenceNotice(): React.JSX.Element | null {
  const theme = useTheme();
  const licence = useLicence();
  const notice = licenceNotice(licence);

  if (!notice) return null;

  const tone = notice.tone === "danger" ? theme.colors.danger : theme.colors.warning;

  return (
    <View
      // `alert` rather than `text`: a screen reader should announce this on arrival rather than
      // wait to be walked onto it.
      accessibilityRole="alert"
      style={[styles.bar, { backgroundColor: theme.colors.bgElevated, borderBottomColor: tone }]}
    >
      <Text style={[typography.caption, { color: theme.colors.fg }]}>{notice.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    // The colour is the signal, so it is on a border rather than a fill: a full amber or red
    // background behind body text is the least readable thing a ward phone can show in sunlight.
    borderBottomWidth: 2,
  },
});
