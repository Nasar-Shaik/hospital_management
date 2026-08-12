/**
 * The ward list — everyone in a bed right now. READ ONLY in this slice.
 *
 * ── FEATURE-GATED BY THE SERVER, NOT BY A FLAG THE PHONE GUESSES ────────────
 * `GET /inpatients` sits behind `module.ops.ipd`. A clinic has no wards and its edition does not
 * carry the flag, so it answers `HMS-PLAN-002` — which the error mapper already turns into "Not
 * included in this edition". The home screen hides its entry point on that code; this screen is
 * still reachable by deep link, so it says the same thing plainly rather than showing an empty ward.
 *
 * This is the honest gate available to a clinician's phone: `GET /subscription` needs
 * `subscription:manage`, an administrator's permission that no DOCTOR or NURSE holds, so the app
 * cannot read the feature list and must not pretend to know it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 * Ward notes, bed transfer, discharge. Those are IPD WRITES and belong to a later slice; a screen
 * that reads a ward is safe to ship first, and shipping it first is how the read path gets proven
 * before anything can change a bed.
 */
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "../src/components/Screen";
import { Card } from "../src/components/Card";
import { Pill } from "../src/components/Pill";
import { QueryGate } from "../src/components/QueryGate";
import { PatientName } from "../src/components/clinical/Identity";
import { EmptyState } from "../src/components/StateView";
import { requireRuntime } from "../src/providers/RuntimeProvider";
import { useCapabilities } from "../src/hooks/useStores";
import { useClinical, useZoneFor } from "../src/hooks/useClinical";
import { useTheme } from "../src/hooks/useTheme";
import { formatDateTime, parseInstant } from "../src/lib/time";
import { encounterStatusLabel, encounterStatusTone } from "../src/clinical/encounters";
import { space, typography } from "../src/theme/tokens";

function Inpatients(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { can, ready: permissionsReady } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  const canRead = can("encounter:read");
  const list = useQuery({ ...queries.inpatients(), enabled: ready && canRead });

  if (permissionsReady && !canRead) {
    return (
      <Screen>
        <EmptyState
          title="You do not have access to the ward list"
          body="Reading visits needs the encounter:read permission. Ask an administrator if you need it."
        />
      </Screen>
    );
  }

  const inpatients = list.data ?? [];

  return (
    <Screen padded={false}>
      <QueryGate
        loading={list.isPending && ready && canRead}
        error={list.error}
        empty={inpatients.length === 0}
        emptyTitle="No patients in beds"
        emptyBody="Admitted patients appear here for as long as they are in a bed."
        loadingLabel="Loading the ward…"
        onRetry={() => void list.refetch()}
      >
        <FlatList
          data={inpatients}
          keyExtractor={(encounter) => encounter.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching}
              onRefresh={() => void list.refetch()}
              tintColor={theme.colors.brand}
            />
          }
          renderItem={({ item }) => {
            const admittedAt = parseInstant(item.admittedAt ?? item.arrivedAt);
            const zone = zoneFor(item.branchId);
            return (
              <Card
                onPress={() =>
                  router.push({
                    pathname: "/patient/[id]",
                    params: { id: item.patientId, encounterId: item.id },
                  })
                }
                accessibilityLabel="Open the inpatient's chart"
              >
                <View style={styles.top}>
                  <View style={styles.name}>
                    <PatientName patientId={item.patientId} />
                  </View>
                  <Pill
                    label={encounterStatusLabel(item.status)}
                    tone={encounterStatusTone(item.status)}
                  />
                </View>

                {/* The bed is RECORDED, not reserved — there is no bed inventory invariant behind
                    it, so it is shown as what the chart says rather than as an allocation. */}
                <Text style={[typography.body, { color: theme.colors.fg }]}>
                  {item.bed ? `${item.bed.ward} · bed ${item.bed.bedCode}` : "Bed not recorded"}
                </Text>

                {admittedAt ? (
                  <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                    Admitted {formatDateTime(admittedAt, zone)}
                  </Text>
                ) : null}
              </Card>
            );
          }}
        />
      </QueryGate>
    </Screen>
  );
}

export default requireRuntime(Inpatients);

const styles = StyleSheet.create({
  list: { gap: space[2], padding: space[4], paddingBottom: space[8] },
  top: { flexDirection: "row", alignItems: "center", gap: space[2] },
  name: { flex: 1 },
});
