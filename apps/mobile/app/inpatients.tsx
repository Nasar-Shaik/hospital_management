/**
 * The ward round (M2 J) — everyone in a bed, in the order you walk past them.
 *
 * ── TWO ENDPOINTS, JOINED, NEITHER INVENTED ─────────────────────────────────
 * `GET /inpatients` says WHO is admitted. `GET /bed-board` says WHERE every bed is and, for the
 * occupied ones, who is in it — name and UHID resolved server-side in a single query. Joining them
 * on `encounterId` is what makes this list read as people rather than as patient ids, without the
 * per-row `getPatient` the OPD list has to pay (`clinical/Identity.tsx` explains why that gap
 * exists). The inpatient list stays the authority on who is admitted: a stay the board has not
 * heard of still appears, under a heading that says its bed is not in the inventory.
 *
 * ── THE BOARD IS AN ENRICHMENT, SO ITS ABSENCE IS SURVIVABLE ────────────────
 * `/bed-board` needs `emr:read` while `/inpatients` needs `encounter:read`, and a role could hold
 * one without the other. When the board is missing for any reason — permission, error, a hospital
 * with no inventory — the rows fall back to the per-patient name lookup and the wards fall back to
 * the free-text `bed.ward` recorded at admission. Degraded, never blank.
 *
 * ── FEATURE-GATED BY THE SERVER'S OWN REFUSAL ───────────────────────────────
 * Both endpoints sit behind `module.ops.ipd`. A clinic has no wards, so it answers `HMS-PLAN-002`
 * and this screen says "not in this edition" rather than showing an empty ward — which would read
 * as "everyone has gone home". No clinician may read `/subscription` to learn this in advance
 * (`subscription:manage` is an administrator's), so the refusal IS the flag.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 * Bed transfer. `POST /encounters/:id/transfer-bed` needs `bed:allocate`, which the DOCTOR role
 * does not hold — it belongs to the nurse who runs the board. The API existing is not a reason to
 * put a button in front of somebody whose only possible outcome is a 403.
 */
import { useMemo, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Screen } from "../src/components/Screen";
import { Button } from "../src/components/Button";
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
import { isFeatureUnavailable } from "../src/lib/net/errors";
import { encounterStatusLabel, encounterStatusTone } from "../src/clinical/encounters";
import {
  dayOfStay,
  groupByWard,
  placementLabel,
  wardKindLabel,
  type RoundPatient,
  type WardGroup,
} from "../src/clinical/ipd";
import { radius, size, space, typography } from "../src/theme/tokens";

/** Every ward, or one — a display filter over rows the SERVER already scoped. See below. */
const ALL_WARDS = "__all__";

function Inpatients(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { can, ready: permissionsReady } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  const [ward, setWard] = useState<string>(ALL_WARDS);

  const canReadEncounters = can("encounter:read");
  const canReadChart = can("emr:read");

  const list = useInfiniteQuery({ ...queries.inpatients(), enabled: ready && canReadEncounters });
  const board = useQuery({ ...queries.bedBoard(), enabled: ready && canReadChart });

  /**
   * Every page so far, flattened, in the order the server sent them — which is ward then bed then
   * `_id`, a TOTAL order, so no patient can appear on two pages or fall between them.
   */
  const inpatients = useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items),
    [list.data],
  );
  const groups = useMemo(() => groupByWard(inpatients, board.data), [inpatients, board.data]);

  /** The hospital's real number, from `meta.total` — not "how many rows have loaded". */
  const total = list.data?.pages[0]?.meta.total ?? inpatients.length;

  /**
   * ── THIS FILTER IS A VIEW, NOT AN ACCESS CONTROL ────────────────────────────
   * Every row here already passed `scopeFilter()` on the server; nothing on this phone decides who
   * a doctor may see. Narrowing to one ward is the same act as scrolling to it — it exists because
   * a consultant covering ICU should not scroll past forty general-ward patients to find four.
   */
  const sections = useMemo(
    () => (ward === ALL_WARDS ? groups : groups.filter((group) => group.ward === ward)),
    [groups, ward],
  );

  if (permissionsReady && !canReadEncounters) {
    return (
      <Screen>
        <EmptyState
          title="You do not have access to the ward list"
          body="Reading visits needs the encounter:read permission. Ask an administrator if you need it."
        />
      </Screen>
    );
  }

  // "Your hospital did not buy wards" is a different sentence from "something went wrong", and the
  // recovery is different too — there is none, so no retry is offered.
  if (isFeatureUnavailable(list.error)) {
    return (
      <Screen>
        <EmptyState
          title="Inpatients are not included in this edition"
          body="This hospital's plan does not include ward management. An administrator can change the plan."
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <QueryGate
        loading={list.isPending && ready && canReadEncounters}
        error={list.error}
        empty={inpatients.length === 0}
        emptyTitle="No patients in beds"
        emptyBody="Admitted patients appear here for as long as they are in a bed."
        loadingLabel="Loading the ward…"
        onRetry={() => void list.refetch()}
      >
        <SectionList
          sections={sections.map((group) => ({ group, data: group.patients }))}
          keyExtractor={(item) => item.encounter.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled
          refreshControl={
            <RefreshControl
              refreshing={list.isRefetching || board.isRefetching}
              onRefresh={() => {
                void list.refetch();
                void board.refetch();
              }}
              tintColor={theme.colors.brand}
            />
          }
          /**
           * ── THE FILTER AND INFINITE LOADING HAVE TO COOPERATE ────────────────────
           * `onEndReached` fires against the FILTERED list, so a doctor narrowed to a four-bed ICU
           * would stop paging and never discover the ICU patients still on page three. The fetch is
           * therefore driven by whether the SERVER has more, not by what is on screen.
           */
          onEndReached={() => {
            if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <WardFilter
              groups={groups}
              selected={ward}
              onSelect={setWard}
              total={total}
              loaded={inpatients.length}
            />
          }
          ListFooterComponent={
            list.hasNextPage ? (
              <LoadMore
                loading={list.isFetchingNextPage}
                remaining={total - inpatients.length}
                onPress={() => void list.fetchNextPage()}
              />
            ) : null
          }
          renderSectionHeader={({ section }) => <WardHeader group={section.group} />}
          renderItem={({ item }) => (
            <RoundRow
              patient={item}
              zone={zoneFor(item.encounter.branchId)}
              onPress={() =>
                router.push({
                  pathname: "/patient/[id]",
                  params: { id: item.encounter.patientId, encounterId: item.encounter.id },
                })
              }
            />
          )}
        />
      </QueryGate>
    </Screen>
  );
}

/**
 * The ward chips, and the honest count above them.
 *
 * The count is of ROWS on this list, and it is labelled that way. Bed occupancy — how many beds are
 * free — is the board's number and appears per ward below; conflating them would let a phone
 * showing twenty rows imply a twenty-bed hospital.
 */
function WardFilter({
  groups,
  selected,
  onSelect,
  total,
  loaded,
}: {
  groups: readonly WardGroup[];
  selected: string;
  onSelect: (ward: string) => void;
  /** The hospital's count, from `meta.total`. */
  total: number;
  /** How many have been fetched so far. */
  loaded: number;
}): React.JSX.Element {
  const theme = useTheme();

  return (
    <View style={styles.header}>
      {/**
       * The count is the WARD's, not the page's.
       *
       * `meta.total` is what the server counted, so this says "48 patients in beds" from the first
       * page onward and reads "showing 40" underneath while the rest loads. Before the endpoint was
       * paged there was no total at all and this line could only report what had arrived — which,
       * past a hundred stays, was a smaller number stated as a fact.
       */}
      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
        {total === 1 ? "1 patient in a bed" : `${String(total)} patients in beds`}
        {loaded < total ? ` · showing ${String(loaded)}` : ""}
      </Text>

      {groups.length > 1 ? (
        <View style={styles.chips}>
          <Chip
            label="All wards"
            selected={selected === ALL_WARDS}
            onPress={() => onSelect(ALL_WARDS)}
          />
          {groups.map((group) => (
            <Chip
              key={group.ward}
              label={group.ward}
              selected={selected === group.ward}
              onPress={() => onSelect(group.ward)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A ward heading, with the SERVER's occupancy beside it.
 *
 * `free` is the number a doctor about to admit actually needs, and it is never computed here — it
 * comes from `/bed-board`, which derives it from the whole ward's beds and every open stay in one
 * query. A count assembled from the rows on screen would describe the page, not the ward, and a bed
 * board that disagrees with the ward clerk's is worse than none.
 */
function WardHeader({ group }: { group: WardGroup }): React.JSX.Element {
  const theme = useTheme();
  const kind = wardKindLabel(group.wardKind);

  return (
    <View style={[styles.wardHeader, { backgroundColor: theme.colors.bg }]}>
      <Text style={[typography.label, styles.wardName, { color: theme.colors.fg }]}>
        {group.ward}
        {kind && kind !== group.ward ? (
          <Text style={{ color: theme.colors.fgSubtle }}> · {kind}</Text>
        ) : null}
      </Text>
      {group.occupancy ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          {String(group.occupancy.free)} free of {String(group.occupancy.total)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One patient on the round.
 *
 * Name, then bed, then how long they have been in it. The whole card is the touch target — a
 * gloved thumb in a corridor does not aim, and every row leads to exactly one place.
 */
function RoundRow({
  patient,
  zone,
  onPress,
}: {
  patient: RoundPatient;
  zone: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { encounter, placement } = patient;
  const admitted = parseInstant(encounter.admittedAt ?? encounter.arrivedAt);

  return (
    <Card onPress={onPress} accessibilityLabel="Open the inpatient's chart">
      <View style={styles.top}>
        <View style={styles.name}>
          {/* The board's name when it has one, otherwise the per-patient lookup — see the header. */}
          {patient.patientName ? (
            <Text style={[typography.heading, { color: theme.colors.fg }]} numberOfLines={1}>
              {patient.patientName}
            </Text>
          ) : (
            <PatientName patientId={encounter.patientId} />
          )}
          {patient.uhid ? (
            <Text style={[typography.caption, styles.uhid, { color: theme.colors.fgMuted }]}>
              UHID {patient.uhid}
            </Text>
          ) : null}
        </View>
        <Pill
          label={encounterStatusLabel(encounter.status)}
          tone={encounterStatusTone(encounter.status)}
        />
      </View>

      <Text style={[typography.body, { color: theme.colors.fg }]}>{placementLabel(placement)}</Text>

      {admitted ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Day {String(dayOfStay(admitted, new Date(), zone))} · admitted{" "}
          {formatDateTime(admitted, zone)}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The tail of the list — and a TAPPABLE one, not only a spinner.
 *
 * `onEndReached` is unreliable in exactly the situation that matters here: a doctor filtered to one
 * ward may have a screen that does not scroll, so the event never fires and the remaining pages
 * never load. An explicit control is the fallback, and it states how many are still to come so the
 * absence is visible rather than inferred.
 */
function LoadMore({
  loading,
  remaining,
  onPress,
}: {
  loading: boolean;
  remaining: number;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.more}>
      {loading ? (
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          Loading more patients…
        </Text>
      ) : (
        <Button
          label={remaining > 0 ? `Load ${String(remaining)} more` : "Load more"}
          variant="secondary"
          onPress={onPress}
        />
      )}
    </View>
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

export default requireRuntime(Inpatients);

const styles = StyleSheet.create({
  list: { gap: space[2], padding: space[4], paddingBottom: space[8] },
  header: { gap: space[2], paddingBottom: space[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[1] },
  chip: {
    ...typography.caption,
    minHeight: size.touchTarget - 16,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderWidth: 1,
    borderRadius: radius.full,
    overflow: "hidden",
  },
  wardHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[2],
    paddingVertical: space[2],
  },
  wardName: { textTransform: "uppercase", letterSpacing: 0.5 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: space[2] },
  name: { flex: 1, gap: 2 },
  uhid: { fontVariant: ["tabular-nums"] },
  more: { paddingTop: space[3] },
});
