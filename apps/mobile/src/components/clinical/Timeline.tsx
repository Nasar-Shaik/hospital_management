/**
 * The patient's story, newest first.
 *
 * Each row is stamped in the zone of the SITE the event happened at, resolved per row — in
 * All-branches mode one list legitimately spans sites, and a single zone for the screen would
 * misdate half of it. The day heading follows the same rule, which is why `formatRelativeDay` takes
 * a zone rather than asking the device what day it is.
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";
import { radius, space, typography } from "../../theme/tokens";
import { formatRelativeDay, formatTime, parseInstant } from "../../lib/time";
import type { TimelineEvent, TimelineKind } from "../../clinical/timeline";
import type { ZoneResolver } from "../../clinical/zone";
import { CriticalFlag } from "../Pill";

/** A word, not a colour: the kind has to survive a monochrome screenshot and a colour deficiency. */
const KIND_LABEL: Record<TimelineKind, string> = {
  visit: "Visit",
  note: "Note",
  order: "Ordered",
  result: "Result",
  prescription: "Prescription",
  vitals: "Vitals",
};

export function TimelineRow({
  event,
  zoneFor,
  onPress,
}: {
  event: TimelineEvent;
  zoneFor: ZoneResolver;
  onPress?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const zone = zoneFor(event.branchId);
  const at = parseInstant(event.at);

  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: event.critical
                ? theme.colors.criticalClinical
                : theme.colors.borderStrong,
            },
          ]}
        />
        <View style={[styles.rail, { backgroundColor: theme.colors.border }]} />
      </View>

      <Pressable
        disabled={!onPress}
        onPress={onPress}
        accessibilityRole={onPress ? "button" : undefined}
        style={({ pressed }) => [styles.body, { opacity: pressed && onPress ? 0.7 : 1 }]}
      >
        <View style={styles.head}>
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            {KIND_LABEL[event.kind]}
          </Text>
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            {at ? formatTime(at, { zone }) : "—"}
          </Text>
          {event.critical ? <CriticalFlag /> : null}
        </View>

        <Text style={[typography.body, { color: theme.colors.fg }]}>{event.title}</Text>

        {event.detail ? (
          <Text style={[typography.caption, { color: theme.colors.fgMuted }]} numberOfLines={3}>
            {event.detail}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

/** The date heading above a group of events, in that group's own zone. */
export function TimelineDay({ at, zone }: { at: string; zone: string }): React.JSX.Element {
  const theme = useTheme();
  const instant = parseInstant(at);
  return (
    <Text style={[typography.label, styles.day, { color: theme.colors.fg }]}>
      {instant ? formatRelativeDay(instant, zone) : "Undated"}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space[3] },
  gutter: { alignItems: "center", width: 12 },
  dot: { width: 10, height: 10, borderRadius: radius.full, marginTop: 5 },
  rail: { flex: 1, width: 2 },
  body: { flex: 1, paddingBottom: space[4], gap: 2 },
  head: { flexDirection: "row", alignItems: "center", gap: space[2] },
  day: { marginTop: space[2] },
});
