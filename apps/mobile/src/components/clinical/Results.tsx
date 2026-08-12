/**
 * Orders and their results.
 *
 * ── THE RELEASE GATE IS HONOURED IN THE RENDERER TOO ────────────────────────
 * `isResultReadable` is asked before any value is drawn. A number that has been run but not signed
 * off must not reach the person who will act on it (STATE_MACHINE_CATALOG §15) — and "the field was
 * present so I rendered it" is exactly how that rule gets lost in a UI.
 */
import { StyleSheet, Text, View } from "react-native";
import type { Order } from "@medicore/api-client";
import { useTheme } from "../../hooks/useTheme";
import { space, typography } from "../../theme/tokens";
import { toneColors } from "../../theme/tone";
import { formatDateTime, parseInstant } from "../../lib/time";
import {
  isCriticalResult,
  isResultReadable,
  orderCategoryLabel,
  orderPriorityLabel,
  orderPriorityTone,
  orderStatusLabel,
  orderStatusTone,
  valueTone,
} from "../../clinical/results";
import { Card } from "../Card";
import { CriticalFlag, Pill } from "../Pill";

export function OrderRow({
  order,
  zone,
  onPress,
}: {
  order: Order;
  zone: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const critical = isCriticalResult(order);
  const orderedAt = parseInstant(order.orderedAt);

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${order.name}, ${orderStatusLabel(order.status)}${critical ? ", critical result" : ""}`}
      style={
        // A left rule, in addition to the CRITICAL word — a red edge is findable while scrolling
        // fast, which a badge in the second row of a card is not.
        critical
          ? { borderLeftWidth: 4, borderLeftColor: theme.colors.criticalClinical }
          : undefined
      }
    >
      <View style={styles.top}>
        <Text
          style={[typography.heading, styles.name, { color: theme.colors.fg }]}
          numberOfLines={2}
        >
          {order.name}
        </Text>
        {critical ? <CriticalFlag /> : null}
      </View>

      <View style={styles.meta}>
        <Pill label={orderStatusLabel(order.status)} tone={orderStatusTone(order.status)} />
        {order.priority === "routine" ? null : (
          <Pill
            label={orderPriorityLabel(order.priority)}
            tone={orderPriorityTone(order.priority)}
          />
        )}
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {orderCategoryLabel(order.category)}
        </Text>
      </View>

      {isResultReadable(order) && order.result?.summary ? (
        <Text style={[typography.body, { color: theme.colors.fg }]} numberOfLines={2}>
          {order.result.summary}
        </Text>
      ) : null}

      {orderedAt ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Ordered {formatDateTime(orderedAt, zone)}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The values table for one released result.
 *
 * Renders NOTHING when the result is not readable, rather than an empty table with a heading — a
 * heading over nothing reads as "no abnormalities", which is a different clinical statement from
 * "not released yet".
 */
export function ResultValues({ order }: { order: Order }): React.JSX.Element | null {
  const theme = useTheme();
  if (!isResultReadable(order)) return null;

  const values = order.result?.values ?? [];

  return (
    <View style={styles.values}>
      {order.result?.summary ? (
        <Text style={[typography.body, { color: theme.colors.fg }]}>{order.result.summary}</Text>
      ) : null}

      {values.map((value) => {
        const colors = toneColors(theme, valueTone(value.flag));
        return (
          <View
            key={value.code}
            style={[styles.valueRow, { borderColor: theme.colors.border }]}
            accessibilityLabel={`${value.label} ${value.value} ${value.unit ?? ""} ${value.flag ?? ""}`}
          >
            <Text style={[typography.caption, styles.valueLabel, { color: theme.colors.fgMuted }]}>
              {value.label}
            </Text>
            <Text style={[typography.body, styles.valueNumber, { color: colors.fg }]}>
              {value.value}
              {value.unit ? ` ${value.unit}` : ""}
            </Text>
            <Text style={[typography.caption, styles.valueRange, { color: theme.colors.fgSubtle }]}>
              {value.referenceRange ?? ""}
            </Text>
          </View>
        );
      })}

      {values.length === 0 && !order.result?.summary ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Released with no structured values. The report file holds the detail.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "flex-start", gap: space[2] },
  name: { flex: 1 },
  meta: { flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" },
  values: { gap: space[1] },
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space[2],
    borderTopWidth: 1,
    paddingTop: space[2],
  },
  valueLabel: { flex: 2 },
  valueNumber: { flex: 2, fontWeight: "600", fontVariant: ["tabular-nums"] },
  valueRange: { flex: 2, textAlign: "right", fontVariant: ["tabular-nums"] },
});
