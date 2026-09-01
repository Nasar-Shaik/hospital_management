/**
 * One result, in full (M2 F).
 *
 * ── THE ONE EXTRA LEVEL OF DEPTH IN THIS SLICE, AND WHY IT EARNS IT ─────────
 * Everything else about a patient lives on one screen. A lab report does not fit: a metabolic panel
 * is fourteen analytes, each with a value, a unit, a reference range and possibly a flag, and
 * squeezing that into a chart row either truncates it or turns the row into a wall. So the summary
 * is inline and the numbers are here.
 *
 * ── THE RELEASE GATE, AGAIN, AT THE LAST POSSIBLE POINT ─────────────────────
 * `ResultValues` renders nothing until the order is `released`. A number that has been run but not
 * verified must not reach the person who will act on it (STATE_MACHINE_CATALOG §15) — and this
 * screen is where somebody would be most tempted to "just show what we have". The status line says
 * what is being waited for instead, which is the useful thing anyway.
 */
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { CriticalFlag, Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { ResultValues } from "../../src/components/clinical/Results";
import { PatientName } from "../../src/components/clinical/Identity";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDateTime, parseInstant } from "../../src/lib/time";
import {
  isCriticalResult,
  isResultReadable,
  orderCategoryLabel,
  orderPriorityLabel,
  orderPriorityTone,
  orderStatusLabel,
  orderStatusTone,
} from "../../src/clinical/results";
import { space, typography } from "../../src/theme/tokens";

function OrderDetail(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  const order = useQuery({ ...queries.order(id), enabled: ready });
  const data = order.data;
  const zone = zoneFor(data?.branchId);

  const orderedAt = parseInstant(data?.orderedAt);
  const releasedAt = parseInstant(data?.releasedAt);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={order.isRefetching}
            onRefresh={() => void order.refetch()}
            tintColor={theme.colors.brand}
          />
        }
      >
        <QueryGate
          loading={order.isPending && ready}
          error={order.error}
          emptyTitle="Order not found"
          loadingLabel="Loading the result…"
          onRetry={() => void order.refetch()}
        >
          {data ? (
            <>
              {isCriticalResult(data) ? (
                <View
                  style={[styles.banner, { backgroundColor: theme.colors.criticalClinical }]}
                  accessibilityRole="alert"
                >
                  <Text style={[typography.label, { color: theme.colors.bg }]}>
                    CRITICAL RESULT — the laboratory flagged this for immediate attention
                  </Text>
                </View>
              ) : null}

              <View style={styles.heading}>
                <Text style={[typography.title, { color: theme.colors.fg }]}>{data.name}</Text>
                <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                  {orderCategoryLabel(data.category)} · {data.code}
                </Text>
              </View>

              <View style={styles.pills}>
                <Pill label={orderStatusLabel(data.status)} tone={orderStatusTone(data.status)} />
                {data.priority === "routine" ? null : (
                  <Pill
                    label={orderPriorityLabel(data.priority)}
                    tone={orderPriorityTone(data.priority)}
                  />
                )}
                {isCriticalResult(data) ? <CriticalFlag /> : null}
              </View>

              <Card
                onPress={() =>
                  router.push({ pathname: "/patient/[id]", params: { id: data.patientId } })
                }
                accessibilityLabel="Open the patient's chart"
              >
                <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Patient</Text>
                <PatientName patientId={data.patientId} />
              </Card>

              <SectionTitle title="Result" />
              {isResultReadable(data) ? (
                <Card>
                  <ResultValues order={data} />
                </Card>
              ) : (
                <Card>
                  <Text style={[typography.body, { color: theme.colors.fgMuted }]}>
                    {data.status === "cancelled"
                      ? "This order was cancelled."
                      : `Not released yet — ${orderStatusLabel(data.status).toLowerCase()}.`}
                  </Text>
                  {data.status === "completed" || data.status === "verified" ? (
                    <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                      Results are shown once the laboratory releases them, so nobody acts on a value
                      a second pair of eyes has not confirmed.
                    </Text>
                  ) : null}
                  {data.cancelReason ? (
                    <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
                      {data.cancelReason}
                    </Text>
                  ) : null}
                </Card>
              )}

              <SectionTitle title="Trail" />
              <Card>
                {data.notes ? (
                  <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
                    {data.notes}
                  </Text>
                ) : null}
                {orderedAt ? (
                  <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                    Ordered {formatDateTime(orderedAt, zone)}
                  </Text>
                ) : null}
                {releasedAt ? (
                  <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                    Released {formatDateTime(releasedAt, zone)}
                  </Text>
                ) : null}
              </Card>
            </>
          ) : null}
        </QueryGate>
      </ScrollView>
    </Screen>
  );
}

export default requireRuntime(OrderDetail);

const styles = StyleSheet.create({
  body: { gap: space[3], paddingBottom: space[8] },
  banner: { padding: space[3], borderRadius: 12 },
  heading: { gap: 2 },
  pills: { flexDirection: "row", gap: space[2], flexWrap: "wrap" },
});
