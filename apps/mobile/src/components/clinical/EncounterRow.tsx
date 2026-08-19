/**
 * One visit in a list — the row a ward round is worked from.
 *
 * Reading order matches how the row is used: the TOKEN (what the waiting room is called by), the
 * NAME, then the status and when they arrived. Tapping anywhere on the row opens the chart, so the
 * target is the full width rather than the name.
 *
 * The name comes off the ROW. `GET /encounters` carries it (D18), so a list of twenty patients
 * costs one request and not twenty-one — see `Identity.tsx`, which asked for exactly this.
 */
import { StyleSheet, Text, View } from "react-native";
import type { EncounterRow as ListedEncounter } from "@medicore/api-client";
import { useTheme } from "../../hooks/useTheme";
import { radius, space, typography } from "../../theme/tokens";
import { formatTime, parseInstant } from "../../lib/time";
import {
  encounterClassLabel,
  encounterStatusLabel,
  encounterStatusTone,
} from "../../clinical/encounters";
import { Card } from "../Card";
import { Pill } from "../Pill";

export function EncounterRow({
  encounter,
  zone,
  onPress,
}: {
  encounter: ListedEncounter;
  /** Resolved by the caller from the record's own branch — never the device's. */
  zone: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const arrived = parseInstant(encounter.arrivedAt);

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`Open chart, token ${String(encounter.token ?? 0)}`}
    >
      <View style={styles.top}>
        {encounter.token !== undefined ? (
          <View style={[styles.token, { backgroundColor: theme.colors.brandStrong }]}>
            <Text style={[styles.tokenText, { color: theme.colors.onAccent }]}>
              {encounter.token}
            </Text>
          </View>
        ) : null}
        <View style={styles.name}>
          {/* The row's OWN name, sent by the server (D18). This used to be a `<PatientName>` that
              fetched the patient behind every row — twenty rows, twenty requests, and a ward round
              that opened on "Loading patient…" twenty times. */}
          <Text style={[typography.heading, { color: theme.colors.fg }]} numberOfLines={1}>
            {encounter.patientName}
          </Text>
        </View>
        {encounter.express ? <Pill label="Express" tone="warning" /> : null}
      </View>

      <View style={styles.meta}>
        <Pill
          label={encounterStatusLabel(encounter.status)}
          tone={encounterStatusTone(encounter.status)}
        />
        {encounter.class === "OP" ? null : (
          <Pill label={encounterClassLabel(encounter.class)} tone="neutral" />
        )}
        {arrived ? (
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            {formatTime(arrived, { zone })}
          </Text>
        ) : null}
      </View>

      {encounter.bed ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          {encounter.bed.ward} · bed {encounter.bed.bedCode}
        </Text>
      ) : null}

      {encounter.reason ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]} numberOfLines={2}>
          {encounter.reason}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", gap: space[2] },
  token: {
    minWidth: 32,
    height: 28,
    paddingHorizontal: space[1],
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tokenText: { ...typography.label, fontVariant: ["tabular-nums"] },
  name: { flex: 1 },
  meta: { flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" },
});
