/**
 * My patients (M2 D) — the doctor's own list, in the order a waiting room accepts as fair.
 *
 * ── THE FILTER IS THE SERVER'S, AND THAT IS A SAFETY PROPERTY ───────────────
 * `?doctorId=` goes on the request. The web app used to fetch the whole queue and narrow it in the
 * browser, with a fallback that quietly showed every UNASSIGNED patient to every doctor — so two
 * consultants each believed the same person was theirs. Filtering server-side means the wrong rows
 * never leave the database. Nothing on this screen filters for access; the chips below narrow a
 * list the server has already decided this caller may see.
 *
 * ── PAGINATION, BECAUSE A CLINIC DAY IS NOT TWENTY PEOPLE ───────────────────
 * `useInfiniteQuery` over `page`/`limit`, with the branch in the key like every other clinical
 * read. "Load more" is a button rather than an invisible scroll trigger: a list that grows while
 * you are reading it loses your place, and a ward round is read standing up.
 */
import { useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Encounter, EncounterStatus } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Button } from "../../src/components/Button";
import { QueryGate } from "../../src/components/QueryGate";
import { EncounterRow } from "../../src/components/clinical/EncounterRow";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDayKey } from "../../src/lib/time";
import { sortForRound } from "../../src/clinical/encounters";
import { radius, size, space, typography } from "../../src/theme/tokens";

/**
 * The three questions a doctor actually asks of their list. `Today` is deliberately first and
 * default: an unfiltered list of every visit this doctor has ever had is a slower way of answering
 * every one of them.
 */
type Scope = "today" | "waiting" | "results";

const SCOPES: { key: Scope; label: string; status?: EncounterStatus; queued?: boolean }[] = [
  { key: "today", label: "Today" },
  { key: "waiting", label: "Waiting", queued: true },
  { key: "results", label: "At lab", status: "awaiting_results" },
];

export default function MyPatients(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("today");
  const { can, ready: permissionsReady } = useCapabilities();
  const { queries, ready, userId } = useClinical();
  const zoneFor = useZoneFor();

  const selected = SCOPES.find((s) => s.key === scope) ?? SCOPES[0];
  const canRead = can("encounter:read");

  /**
   * `date` is applied only to the default scope. "Waiting" and "At lab" are states, not days — a
   * patient who arrived last night and is still awaiting results must not vanish from the list at
   * midnight, which is exactly what pinning them to today's date would do.
   */
  const list = useInfiniteQuery({
    ...queries.myPatients({
      doctorId: userId ?? "",
      ...(scope === "today" ? { date: formatDayKey(new Date(), zoneFor(undefined)) } : {}),
      ...(selected?.status ? { status: selected.status } : {}),
      ...(selected?.queued ? { queued: true } : {}),
    }),
    enabled: ready && Boolean(userId) && canRead,
  });

  if (permissionsReady && !canRead) return <Redirect href="/" />;

  const encounters: Encounter[] = sortForRound(
    list.data?.pages.flatMap((page) => page.items) ?? [],
  );

  return (
    <Screen padded={false}>
      <View style={styles.filters}>
        {SCOPES.map((option) => {
          const on = option.key === scope;
          return (
            <Chip
              key={option.key}
              label={option.label}
              selected={on}
              onPress={() => setScope(option.key)}
            />
          );
        })}
      </View>

      <QueryGate
        loading={list.isPending && ready && canRead}
        error={list.error}
        empty={encounters.length === 0}
        emptyTitle={scope === "today" ? "Nobody assigned to you" : "Nothing here"}
        emptyBody={
          scope === "today"
            ? "Patients the front desk sends to you appear here, in token order."
            : "Nothing matches this filter right now."
        }
        loadingLabel="Loading your patients…"
        onRetry={() => void list.refetch()}
      >
        <FlatList
          data={encounters}
          keyExtractor={(encounter) => encounter.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching && !list.isFetchingNextPage}
              onRefresh={() => void list.refetch()}
              tintColor={theme.colors.brand}
            />
          }
          renderItem={({ item }) => (
            <EncounterRow
              encounter={item}
              zone={zoneFor(item.branchId)}
              onPress={() =>
                router.push({
                  pathname: "/patient/[id]",
                  params: { id: item.patientId, encounterId: item.id },
                })
              }
            />
          )}
          ListFooterComponent={
            list.hasNextPage ? (
              <View style={styles.more}>
                <Button
                  label={list.isFetchingNextPage ? "Loading…" : "Load more"}
                  variant="secondary"
                  loading={list.isFetchingNextPage}
                  onPress={() => void list.fetchNextPage()}
                />
              </View>
            ) : encounters.length > 0 ? (
              <Text style={[styles.end, { color: theme.colors.fgSubtle }]}>
                {encounters.length === 1 ? "1 patient" : `${String(encounters.length)} patients`}
              </Text>
            ) : null
          }
        />
      </QueryGate>
    </Screen>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          color: selected ? theme.colors.onAccent : theme.colors.fgMuted,
          backgroundColor: selected ? theme.colors.brandStrong : theme.colors.bgSubtle,
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
        },
      ]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", gap: space[2], padding: space[4], paddingBottom: space[2] },
  chip: {
    ...typography.label,
    borderWidth: 1,
    borderRadius: radius.full,
    // 44 is Apple's floor and 48 Android's; a filter tapped mid-round with gloves gets the larger.
    minHeight: size.touchTarget - 12,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    overflow: "hidden",
  },
  list: { gap: space[2], padding: space[4], paddingTop: space[2], paddingBottom: space[8] },
  more: { paddingTop: space[2] },
  end: { ...typography.caption, textAlign: "center", paddingTop: space[3] },
});
