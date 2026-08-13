/**
 * The ward worklist (M3-S3) — the nurse's home screen.
 *
 * ── ONE REQUEST PER PAGE, NOT SIXTY-ONE ─────────────────────────────────────
 * Every row shows allergy state and how many doses are due. Assembled on the phone that would be
 * a per-patient allergy call and a per-encounter schedule call on top of the list itself. The
 * server answers all of it in `GET /ward-worklist` — four queries however long the page — so this
 * screen makes exactly one request per page and adds `/bed-board` once for names.
 *
 * ── THE PHONE DECIDES NOTHING CLINICAL ──────────────────────────────────────
 * `dosesDue` and `dosesOverdue` are the SERVER's, resolved in the branch's timezone against real
 * administration rows. This screen sorts and labels them and nothing more. A handset with the
 * wrong clock cannot make a late antibiotic look on time, which is the property S1 was built on.
 *
 * ── THE WARD FILTER IS A SERVER FILTER ──────────────────────────────────────
 * The doctor's round (`/inpatients`) filters wards in the client, which is fine when the whole
 * branch is already in hand. A nurse on a 300-bed site is not in that position: paging through
 * the hospital to find their own patients is not a ward round. So `?ward=` goes to the server,
 * and the ward name is part of the query key — the same name means different patients at
 * different sites.
 *
 * ── NOT HERE, DELIBERATELY ──────────────────────────────────────────────────
 * No administration. Charting a dose is S5 and it needs a confirmation step naming the patient,
 * the drug, the dose and the route; a tap target on a scrolling list is exactly how the wrong
 * patient gets the wrong drug. This screen navigates to the chart, and the chart is read-only.
 */
import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WorklistRow } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card } from "../../src/components/Card";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { EmptyState } from "../../src/components/StateView";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { isFeatureUnavailable } from "../../src/lib/net/errors";
import { dayOfStay, identitiesByEncounter } from "../../src/clinical/ipd";
import { bedLabel, flagsFor, quietLabel, triageOrder } from "../../src/clinical/worklist";
import { parseInstant } from "../../src/lib/time";
import { radius, size, space, typography } from "../../src/theme/tokens";

/** No ward chosen — the whole branch, which is what a small hospital wants anyway. */
const EVERY_WARD = "__every__";

function WardWorklist(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { can } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();
  const [ward, setWard] = useState<string>(EVERY_WARD);

  const wardFilter = ward === EVERY_WARD ? undefined : ward;
  const worklist = useInfiniteQuery({
    ...queries.wardWorklist(wardFilter),
    enabled: ready && can("emr:read"),
  });

  /**
   * The board is read ONCE, for names. It is an enrichment: when it is missing — no permission,
   * no bed inventory, an error — the rows still render, identified by their bed. Never blank.
   */
  const board = useQuery({ ...queries.bedBoard(), enabled: ready && can("emr:read") });
  const identities = useMemo(() => identitiesByEncounter(board.data), [board.data]);

  const rows = useMemo(
    () => triageOrder(worklist.data?.pages.flatMap((page) => page.items) ?? []),
    [worklist.data],
  );

  /**
   * The ward names come from the rows already loaded, so the picker can only ever offer wards the
   * server has actually returned. It is a convenience over this page, not a directory — a ward
   * with nobody in it does not appear, which is correct for a worklist.
   */
  const wards = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) if (row.ward) names.add(row.ward);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const zone = zoneFor(undefined);
  const now = new Date();

  if (!can("emr:read")) {
    return (
      <Screen>
        <EmptyState
          title="Not available to you"
          body="The ward worklist needs the emr:read permission."
        />
      </Screen>
    );
  }

  /**
   * `HMS-PLAN-002` means `module.ops.ipd` was not bought — a clinic has no wards. Saying so is
   * the honest answer; an empty ward list would read as "everyone has gone home".
   */
  if (isFeatureUnavailable(worklist.error)) {
    return (
      <Screen>
        <EmptyState
          title="Not in this edition"
          body="Inpatient wards are part of a plan this hospital does not have."
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      {wards.length > 1 ? (
        <View style={styles.filters}>
          <WardChip
            label="All wards"
            selected={ward === EVERY_WARD}
            onPress={() => setWard(EVERY_WARD)}
          />
          {wards.map((name) => (
            <WardChip
              key={name}
              label={name}
              selected={ward === name}
              onPress={() => setWard(name)}
            />
          ))}
        </View>
      ) : null}

      <QueryGate
        loading={worklist.isPending && ready}
        error={worklist.error}
        empty={rows.length === 0}
        emptyTitle="Nobody admitted"
        emptyBody={
          wardFilter
            ? `No open stays in ${wardFilter} right now.`
            : "No patients are in a bed at this branch right now."
        }
        onRetry={() => void worklist.refetch()}
      >
        <FlatList
          data={rows}
          keyExtractor={(row) => row.encounterId}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={worklist.isRefetching}
              onRefresh={() => void worklist.refetch()}
              tintColor={theme.colors.fgSubtle}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (worklist.hasNextPage && !worklist.isFetchingNextPage) {
              void worklist.fetchNextPage();
            }
          }}
          ListFooterComponent={
            worklist.isFetchingNextPage ? (
              <Text style={[typography.caption, styles.footer, { color: theme.colors.fgSubtle }]}>
                Loading more…
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <WorklistCard
              row={item}
              name={identities.get(item.encounterId)?.patientName}
              uhid={identities.get(item.encounterId)?.uhid}
              zone={zone}
              now={now}
              onPress={() =>
                router.push(`/patient/${item.patientId}?encounter=${item.encounterId}`)
              }
            />
          )}
        />
      </QueryGate>
    </Screen>
  );
}

function WardChip({
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
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Show ${label}`}
      style={[
        styles.chip,
        {
          backgroundColor: theme.colors.bgElevated,
          // Selection is carried by the BORDER and the label colour, and announced through
          // `accessibilityState` — never by fill alone (§17).
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <Text
        style={[
          typography.caption,
          { color: selected ? theme.colors.brandStrong : theme.colors.fgSubtle },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One patient.
 *
 * The whole card is the touch target — a nurse taps this with a thumb, standing up, often with
 * one hand — and it carries a single accessibility label so a screen reader reads the patient and
 * their state as one sentence rather than five fragments.
 */
function WorklistCard({
  row,
  name,
  uhid,
  zone,
  now,
  onPress,
}: {
  row: WorklistRow;
  name?: string;
  uhid?: string;
  zone: string;
  now: Date;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const flags = flagsFor(row);
  const quiet = quietLabel(row);
  const admitted = parseInstant(row.admittedAt);
  const day = admitted ? dayOfStay(admitted, now, zone) : undefined;

  const spoken = [
    name ?? "Patient",
    uhid ? `UHID ${uhid}` : undefined,
    bedLabel(row),
    day !== undefined ? `day ${String(day)} of stay` : undefined,
    ...flags.map((f) => f.accessibilityLabel),
    quiet,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <Card>
        <View style={styles.headline}>
          <Text style={[typography.label, { color: theme.colors.fg }]} numberOfLines={1}>
            {name ?? "Patient"}
          </Text>
          {uhid ? (
            <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>{uhid}</Text>
          ) : null}
        </View>

        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {bedLabel(row)}
          {day !== undefined ? ` · Day ${String(day)}` : ""}
        </Text>

        {flags.length > 0 ? (
          <View style={styles.flags}>
            {flags.map((flag) => (
              <Pill key={flag.label} label={flag.label} tone={flag.tone} />
            ))}
          </View>
        ) : quiet ? (
          <Text style={[typography.caption, styles.quiet, { color: theme.colors.fgSubtle }]}>
            {quiet}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[1],
    paddingHorizontal: space[4],
    paddingTop: space[2],
  },
  chip: {
    borderRadius: radius.full,
    borderWidth: 1,
    minHeight: size.touchTarget,
    justifyContent: "center",
    paddingHorizontal: space[4],
  },
  list: { padding: space[4], gap: space[2] },
  row: { minHeight: size.touchTarget },
  headline: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[2],
  },
  flags: { flexDirection: "row", flexWrap: "wrap", gap: space[1], marginTop: space[1] },
  quiet: { marginTop: space[1] },
  footer: { textAlign: "center", padding: space[4] },
});

export default WardWorklist;
