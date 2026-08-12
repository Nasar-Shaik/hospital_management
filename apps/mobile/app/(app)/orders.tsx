/**
 * Results (M2 F) — everything asked for, and what has come back.
 *
 * ── SORTED BY WHAT NEEDS ATTENTION, NOT BY WHEN IT WAS ASKED FOR ────────────
 * Critical first, then outstanding, then the rest — see `clinical/results.ts`. A strictly
 * chronological list buries a panic value from this morning under six routine results that have
 * come back since, and the band is not a filter the user has to discover.
 *
 * ── "OUTSTANDING" IS THE SERVER'S FILTER ────────────────────────────────────
 * `?outstanding=true` is what the department worklists already use, so "what am I waiting for" is
 * answered by the database rather than by paging everything and counting on the phone.
 */
import { useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Screen } from "../../src/components/Screen";
import { Button } from "../../src/components/Button";
import { QueryGate } from "../../src/components/QueryGate";
import { OrderRow } from "../../src/components/clinical/Results";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { sortForReview, summariseResults } from "../../src/clinical/results";
import { radius, size, space, typography } from "../../src/theme/tokens";

export default function Results(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [outstandingOnly, setOutstandingOnly] = useState(true);
  const { can, ready: permissionsReady } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  const canRead = can("order:read");

  const list = useInfiniteQuery({
    ...queries.orders(outstandingOnly ? { outstanding: true } : {}),
    enabled: ready && canRead,
  });

  if (permissionsReady && !canRead) return <Redirect href="/" />;

  const orders = sortForReview(list.data?.pages.flatMap((page) => page.items) ?? []);
  const summary = summariseResults(orders);

  return (
    <Screen padded={false}>
      <View style={styles.filters}>
        <Chip
          label="Outstanding"
          selected={outstandingOnly}
          onPress={() => setOutstandingOnly(true)}
        />
        <Chip label="All" selected={!outstandingOnly} onPress={() => setOutstandingOnly(false)} />
        {summary.critical > 0 ? (
          <Text style={[styles.critical, { color: theme.colors.criticalClinical }]}>
            {summary.critical} critical
          </Text>
        ) : null}
      </View>

      <QueryGate
        loading={list.isPending && ready && canRead}
        error={list.error}
        empty={orders.length === 0}
        emptyTitle={outstandingOnly ? "Nothing outstanding" : "No orders"}
        emptyBody={
          outstandingOnly
            ? "Every test asked for has come back."
            : "Tests ordered at this branch appear here."
        }
        loadingLabel="Loading results…"
        onRetry={() => void list.refetch()}
      >
        <FlatList
          data={orders}
          keyExtractor={(order) => order.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching && !list.isFetchingNextPage}
              onRefresh={() => void list.refetch()}
              tintColor={theme.colors.brand}
            />
          }
          renderItem={({ item }) => (
            <OrderRow
              order={item}
              zone={zoneFor(item.branchId)}
              onPress={() => router.push({ pathname: "/order/[id]", params: { id: item.id } })}
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
  filters: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[2],
    padding: space[4],
    paddingBottom: space[2],
  },
  chip: {
    ...typography.label,
    borderWidth: 1,
    borderRadius: radius.full,
    minHeight: size.touchTarget - 12,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    overflow: "hidden",
  },
  critical: { ...typography.label, marginLeft: "auto" },
  more: { paddingTop: space[2] },
  list: { gap: space[2], padding: space[4], paddingTop: space[2], paddingBottom: space[8] },
});
