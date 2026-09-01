/**
 * Observations, rendered large enough to read across a bed.
 *
 * The numbers get `typography.title`; the labels and units stay small. A vitals panel is scanned,
 * not read, and on a phone held at arm's length the value is the only thing that has to survive.
 */
import { StyleSheet, Text, View } from "react-native";
import type { VitalsReading } from "@medicore/api-client";
import { useTheme } from "../../hooks/useTheme";
import { space, typography } from "../../theme/tokens";
import { toneColors } from "../../theme/tone";
import { formatDateTime, parseInstant } from "../../lib/time";
import { bloodPressure, vitalRows } from "../../clinical/vitals";
import { Card } from "../Card";
import { Pill } from "../Pill";

export function VitalsCard({
  reading,
  zone,
  heading,
}: {
  reading: VitalsReading;
  /** From the record's branch. A dose time in the reader's own zone is the bug this avoids. */
  zone: string;
  heading?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const rows = vitalRows(reading);
  const bp = bloodPressure(reading);
  const recordedAt = parseInstant(reading.recordedAt);

  return (
    <Card>
      <View style={styles.header}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>
          {heading ?? "Vitals"}
        </Text>
        {reading.abnormal ? <Pill label="Out of range" tone="warning" /> : null}
      </View>

      {/* Systolic and diastolic are shown together first — read apart they mean very little — and
          then again as individual rows, where each carries its own server-assigned flag. */}
      {bp ? <Text style={[typography.title, { color: theme.colors.fg }]}>{bp}</Text> : null}

      <View style={styles.grid}>
        {rows.map((row) => {
          const colors = toneColors(theme, row.tone);
          return (
            <View key={row.field} style={styles.cell}>
              <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{row.label}</Text>
              <View style={styles.value}>
                <Text style={[styles.number, { color: colors.fg }]}>{row.value}</Text>
                <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                  {row.unit}
                </Text>
              </View>
              {/* The flag is the SERVER's assessment, spelled out — colour alone is not a signal. */}
              {row.flag && row.flag !== "normal" ? (
                <Text style={[typography.caption, { color: colors.fg }]}>{row.flag}</Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {reading.bmi !== undefined ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          BMI {reading.bmi.toFixed(1)}
        </Text>
      ) : null}

      {reading.notes ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{reading.notes}</Text>
      ) : null}

      {recordedAt ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {formatDateTime(recordedAt, zone)}
        </Text>
      ) : null}
    </Card>
  );
}

/** A past reading, one line, for the trend beneath the latest. */
export function VitalsHistoryRow({
  reading,
  zone,
}: {
  reading: VitalsReading;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const recordedAt = parseInstant(reading.recordedAt);
  const summary = vitalRows(reading)
    .map((row) => `${row.label} ${row.value}${row.unit}`)
    .join("  ·  ");

  return (
    <View style={[styles.historyRow, { borderColor: theme.colors.border }]}>
      <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
        {recordedAt ? formatDateTime(recordedAt, zone) : "—"}
      </Text>
      <Text style={[typography.caption, { color: theme.colors.fg }]}>{summary}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space[4] },
  cell: { minWidth: 88, gap: 2 },
  value: { flexDirection: "row", alignItems: "baseline", gap: space[1] },
  number: { ...typography.heading, fontSize: 22, fontVariant: ["tabular-nums"] },
  historyRow: { borderTopWidth: 1, paddingVertical: space[2], gap: 2 },
});
