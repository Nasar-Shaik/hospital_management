/**
 * The medication round (M3-S5B) — every dose the ward owes today, in one place.
 *
 * ── THIS SCREEN IS A NAVIGATOR AND NOTHING ELSE ─────────────────────────────
 * It performs no clinical write. There is no Give button on a row, no swipe action, no "mark all
 * given", no bulk anything. Tapping an outstanding dose carries its IDENTITY — prescription, line
 * and scheduled instant — to the S5A confirmation screen, which re-reads the slot from the server,
 * names the patient, the drug, the dose and the route, and is the only place in this app that
 * charts a dose. Every safety property S5A proved (the exact line, the idempotency key, the 409
 * reconciliation, the database's duplicate protection) would have to be proved again if this list
 * grew its own write path.
 *
 * ── AND IT HAS NO OPINION ABOUT CLINICAL STATE ──────────────────────────────
 * `due` / `overdue` / `given` / `held` / `refused` are the SERVER's, resolved in the ward's zone
 * against real administration rows. After a dose is charted this screen does NOT patch its copy —
 * it re-reads. The mutation invalidates the branch prefix, the round refetches, and what renders
 * is what the database says. A round that edits its own array develops an opinion the record never
 * agreed to, and the first time that opinion is wrong a nurse gives a second dose.
 *
 * ── THE DAY IS THE WARD'S ───────────────────────────────────────────────────
 * `formatDayKey(now, branchZone)`. At 23:30 in Delhi it is still yesterday afternoon in a New York
 * ward; the round belongs to the ward's day, and the handset's zone decides nothing.
 */
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DoseSlot, MedicationRoundRow } from "@medicore/api-client";
import { Screen } from "../src/components/Screen";
import { Card } from "../src/components/Card";
import { Pill } from "../src/components/Pill";
import { QueryGate } from "../src/components/QueryGate";
import { EmptyState } from "../src/components/StateView";
import { DoseSlotRow } from "../src/components/clinical/Stay";
import { EVERY_WARD, WardPicker } from "../src/components/clinical/WardPicker";
import { requireRuntime } from "../src/providers/RuntimeProvider";
import { useCapabilities } from "../src/hooks/useStores";
import { useClinical, useZoneFor } from "../src/hooks/useClinical";
import { useTheme } from "../src/hooks/useTheme";
import { isFeatureUnavailable } from "../src/lib/net/errors";
import { wardOptions } from "../src/clinical/worklist";
import {
  bedLabel,
  isOutstanding,
  roundFlags,
  roundOrder,
  slotKey,
  slotOrder,
  summariseRound,
  summaryLabel,
  quietLabel,
} from "../src/clinical/round";
import { formatDate, formatDayKey } from "../src/lib/time";
import { size, space, typography } from "../src/theme/tokens";

function MedicationRound(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { can } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  /** The ward the nurse was already looking at, when they came from the worklist. */
  const params = useLocalSearchParams<{ ward?: string }>();
  const [ward, setWard] = useState<string>(params.ward ?? EVERY_WARD);
  const wardFilter = ward === EVERY_WARD ? undefined : ward;

  /**
   * The ward's clock, and the ward's day. `zoneFor(undefined)` is the ACTIVE branch's zone — the
   * one site this request acts in — which is the same branch the server will scope the round to.
   */
  const zone = zoneFor(undefined);
  const now = new Date();
  const date = formatDayKey(now, zone);

  const round = useInfiniteQuery({
    ...queries.medicationRound({ date, ...(wardFilter ? { ward: wardFilter } : {}) }),
    enabled: ready && can("emr:read"),
  });

  const loaded = useMemo(() => round.data?.pages.flatMap((page) => page.items) ?? [], [round.data]);
  const rows = useMemo(() => roundOrder(loaded), [loaded]);
  const wards = useMemo(() => wardOptions(loaded, wardFilter), [loaded, wardFilter]);
  const summary = summariseRound(rows, round.data?.pages[0]?.meta.total);

  /**
   * The nurse may not chart at all — UI gating only, and the server refuses regardless. Without
   * it every row would look actionable and every tap would end in a permission wall, which is a
   * worse answer than a round that is plainly read-only.
   */
  const canAdminister = can("mar:administer");

  if (!can("emr:read")) {
    return (
      <Screen>
        <EmptyState
          title="Not available to you"
          body="The medication round needs the emr:read permission."
        />
      </Screen>
    );
  }

  /**
   * `HMS-PLAN-002` here means `module.clinical.nursing` was not bought — a product boundary no
   * role edit can change. An empty round would read as "nothing is due on this ward", which is a
   * clinically dangerous thing to imply about a ward full of patients on antibiotics.
   */
  if (isFeatureUnavailable(round.error)) {
    return (
      <Screen>
        <EmptyState
          title="Not in this edition"
          body="The medication record is part of a plan this hospital does not have."
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {/* The ward's date, in the ward's zone — never the reader's. */}
          Today · {formatDate(now, zone)}
        </Text>
        <Text
          style={[typography.label, { color: theme.colors.fg }]}
          accessibilityRole="summary"
          accessibilityLabel={summaryLabel(summary)}
        >
          {summaryLabel(summary)}
        </Text>
      </View>

      <WardPicker wards={wards} selected={ward} onSelect={setWard} />

      <QueryGate
        loading={round.isPending && ready}
        error={round.error}
        empty={rows.length === 0}
        emptyTitle={wardFilter ? `Nobody admitted in ${wardFilter}` : "Nobody admitted"}
        emptyBody="A medication round needs patients in beds. Nobody is admitted here right now."
        onRetry={() => void round.refetch()}
      >
        <FlatList
          data={rows}
          keyExtractor={(row) => row.encounterId}
          contentContainerStyle={styles.list}
          refreshControl={
            /**
             * A non-destructive refresh: `isRefetching` spins the control and leaves the rows in
             * place. Returning from a charted dose must not blank the ward — a nurse looking at an
             * empty screen mid-round cannot tell "loading" from "nothing left to give".
             */
            <RefreshControl
              refreshing={round.isRefetching}
              onRefresh={() => void round.refetch()}
              tintColor={theme.colors.fgSubtle}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (round.hasNextPage && !round.isFetchingNextPage) void round.fetchNextPage();
          }}
          ListFooterComponent={
            round.isFetchingNextPage ? (
              <Text style={[typography.caption, styles.footer, { color: theme.colors.fgSubtle }]}>
                Loading more patients…
              </Text>
            ) : !summary.complete ? (
              /**
               * Pagination must never be SILENT on a round. The list is ordered by urgency across
               * what has loaded, so a patient on page two with a late dose sits below everyone on
               * page one — and a nurse who believes they are looking at the whole ward would miss
               * them. Saying so is the difference between deferred and omitted.
               */
              <Text style={[typography.caption, styles.footer, { color: theme.colors.fgMuted }]}>
                Scroll for the rest of the ward — more patients have not loaded yet.
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <RoundCard
              row={item}
              zone={zone}
              onOpenDose={
                canAdminister
                  ? (slot) =>
                      router.push({
                        pathname: "/administer/[encounterId]",
                        params: {
                          encounterId: item.encounterId,
                          /**
                           * Only the slot's IDENTITY travels. Not the drug name, not the dose, not
                           * the state — S5A re-reads all of it, because this list rendered some
                           * seconds ago and another nurse may have answered the dose since.
                           */
                          prescriptionId: slot.prescriptionId,
                          lineIndex: String(slot.lineIndex),
                          scheduledFor: slot.scheduledFor,
                        },
                      })
                  : undefined
              }
            />
          )}
        />
      </QueryGate>
    </Screen>
  );
}

/**
 * One patient, and their doses.
 *
 * ── IDENTITY LEADS, AND IT IS NAME **AND** NUMBER ───────────────────────────
 * Two patients on a ward share a first name more often than anybody expects, and a bed is where
 * somebody was an hour ago. The name and the UHID come from the round endpoint itself rather than
 * from a bed-board join, so a row can never render identified only by its bed.
 */
function RoundCard({
  row,
  zone,
  onOpenDose,
}: {
  row: MedicationRoundRow;
  zone: string;
  onOpenDose?: (slot: DoseSlot) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const flags = roundFlags(row);
  const quiet = quietLabel(row);
  const slots = slotOrder(row.slots);
  /** Spoken before each dose, so a screen reader landing on a row knows whose it is. */
  const who = `${row.patientName}, ${row.uhid ? `UHID ${row.uhid}` : bedLabel(row)}`;

  return (
    <Card>
      <View style={styles.headline}>
        <Text style={[typography.label, { color: theme.colors.fg }]} numberOfLines={1}>
          {row.patientName}
        </Text>
        {row.uhid ? (
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>{row.uhid}</Text>
        ) : null}
      </View>

      <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>{bedLabel(row)}</Text>

      {/**
       * The pills are grouped into ONE accessible element carrying the long form of each. Read
       * individually a screen reader says "2 overdue" with no noun; read as a group it says
       * "2 doses overdue. Severe allergy recorded: penicillins." — and every one of them states
       * its meaning in words, never in tone alone.
       */}
      {flags.length > 0 ? (
        <View
          style={styles.flags}
          accessible
          accessibilityLabel={flags.map((f) => f.accessibilityLabel).join(". ")}
        >
          {flags.map((flag) => (
            <Pill key={flag.label} label={flag.label} tone={flag.tone} />
          ))}
        </View>
      ) : null}

      {/**
       * ── THE ALLERGENS ARE NAMED, AND NEVER MATCHED AGAINST THE DRUGS ──────────
       * There is no drug-allergy engine anywhere in this product and this row must not imply one.
       * It lists what is recorded, beside the drugs, for a human to read. Nothing here ever says a
       * dose is safe, and an empty list is simply absent rather than rendered as clearance.
       */}
      {row.allergens.length > 0 ? (
        <Text style={[typography.caption, { color: theme.colors.warning }]}>
          Allergies: {row.allergens.join(", ")}
        </Text>
      ) : null}

      {slots.length > 0 ? (
        <View style={styles.doses}>
          {slots.map((slot) => (
            <DoseSlotRow
              key={slotKey(slot)}
              slot={slot}
              zone={zone}
              who={who}
              {...(onOpenDose && isOutstanding(slot) ? { onPress: () => onOpenDose(slot) } : {})}
            />
          ))}
        </View>
      ) : null}

      {quiet ? (
        <Text style={[typography.caption, styles.quiet, { color: theme.colors.fgSubtle }]}>
          {quiet}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space[4], paddingTop: space[2], gap: 2 },
  list: { padding: space[4], gap: space[2] },
  headline: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[2],
  },
  flags: { flexDirection: "row", flexWrap: "wrap", gap: space[1], marginTop: space[1] },
  doses: { marginTop: space[2], minHeight: size.touchTarget },
  quiet: { marginTop: space[1] },
  footer: { textAlign: "center", padding: space[4] },
});

export default requireRuntime(MedicationRound);
