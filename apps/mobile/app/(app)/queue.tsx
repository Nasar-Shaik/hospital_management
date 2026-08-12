/**
 * Today — the clinical home (M2 C).
 *
 * ── ENTRY POINTS WITH LIVE NUMBERS, NOT A DASHBOARD ─────────────────────────
 * The question this screen answers is "what needs me right now", and there are only three honest
 * answers on a ward round: people waiting, people in beds, and results that have come back. Each is
 * a card with a real count and a destination. There is no chart, no trend and no tile that exists
 * because a grid looked empty — a doctor opening this between patients has about four seconds.
 *
 * ── IT IS BUILT FROM PERMISSIONS, NOT FROM A ROLE ───────────────────────────
 * No `if (role === "DOCTOR")` anywhere. Each card is present because the user holds the permission
 * its data needs, which is the same rule `tabsFor` uses one level up (M0 §8). A hospital that
 * renames DOCTOR, or builds its own role out of the same grants, gets the same screen. A nurse
 * lands here too and sees an honest empty list rather than somebody else's.
 *
 * ── THE INPATIENT CARD IS GATED BY THE SERVER'S OWN REFUSAL ─────────────────
 * A clinic has no wards, and its edition does not carry `module.ops.ipd`. No clinician may read
 * `/subscription` to find that out, so the app asks for the inpatient list and reads the answer:
 * `HMS-PLAN-002` means the card is not just empty but meaningless, and it disappears. Anything
 * else — including a 403 — is reported, because that one is somebody's misconfiguration rather
 * than a product boundary.
 */
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { EncounterRow } from "../../src/components/clinical/EncounterRow";
import { EmptyState } from "../../src/components/StateView";
import { QueryGate } from "../../src/components/QueryGate";
import { useActiveBranchLabel, useCapabilities, useSession } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDate, formatDayKey } from "../../src/lib/time";
import { isFeatureUnavailable } from "../../src/lib/net/errors";
import { sortForRound, summariseRound } from "../../src/clinical/encounters";
import { space, typography } from "../../src/theme/tokens";

/** How many of the day's patients are previewed before the list takes over. */
const PREVIEW = 3;

/** Guarded by `(app)/_layout`, which every screen in this group renders beneath. */
export default function Today(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { can, ready: permissionsReady } = useCapabilities();
  const { queries, ready, userId } = useClinical();
  const zoneFor = useZoneFor();
  const name = useSession((s) => s.user?.name);
  const branchLabel = useActiveBranchLabel();

  /**
   * `undefined` means "the branch has no zone we can use", and `zoneFor` has already fallen through
   * to the platform default rather than to the device. The day key below is therefore the
   * hospital's day, which is what `?date=` is resolved against server-side — a phone in another
   * timezone must not ask for yesterday's register.
   */
  const zone = zoneFor(undefined);
  const today = formatDayKey(new Date(), zone);

  const canReadEncounters = can("encounter:read");
  const canReadOrders = can("order:read");
  const enabled = ready && Boolean(userId);

  const round = useQuery({
    ...queries.roundToday({ doctorId: userId ?? "", date: today }),
    enabled: enabled && canReadEncounters,
  });

  const inpatients = useQuery({
    ...queries.inpatients(),
    enabled: ready && canReadEncounters,
  });

  const results = useQuery({
    ...queries.outstandingResults(),
    enabled: ready && canReadOrders,
  });

  // A tab is hidden when the permission is missing, but a deep link still resolves here — so the
  // screen re-checks. The server refuses regardless; this is what stops a blank screen.
  if (permissionsReady && !canReadEncounters) return <Redirect href="/" />;

  const encounters = round.data?.items ?? [];
  const summary = summariseRound(encounters);
  const preview = sortForRound(encounters).slice(0, PREVIEW);

  /**
   * `meta.total` rather than `items.length`: the request asks for one row, because the count is
   * the whole point and paging twenty orders to display a number is twenty rows of PHI over the
   * wire for nothing. Older responses may omit `total`, hence the fallback.
   */
  const outstanding = results.data?.meta.total ?? results.data?.items.length ?? 0;

  const ipdUnavailable = isFeatureUnavailable(inpatients.error);
  const admitted = inpatients.data?.length ?? 0;

  const refreshing = round.isRefetching || inpatients.isRefetching || results.isRefetching;
  const refresh = (): void => {
    void round.refetch();
    void inpatients.refetch();
    void results.refetch();
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.colors.brand}
          />
        }
      >
        <View style={styles.heading}>
          <Text style={[typography.title, { color: theme.colors.fg }]}>{name ?? "Today"}</Text>
          <Text style={[typography.body, { color: theme.colors.fgMuted }]}>
            {branchLabel} · {formatDate(new Date(), zone)}
          </Text>
        </View>

        <View style={styles.cards}>
          <EntryCard
            title="My patients"
            value={String(summary.total)}
            caption={
              summary.total === 0
                ? "Nobody assigned to you today"
                : `${String(summary.waiting)} waiting · ${String(summary.inProgress)} with you`
            }
            loading={round.isPending && enabled && canReadEncounters}
            onPress={() => router.push("/patients")}
          />

          {/* Absent when the hospital has no wards — see the header. */}
          {canReadEncounters && !ipdUnavailable ? (
            <EntryCard
              title="Inpatients"
              value={String(admitted)}
              caption={admitted === 1 ? "patient in a bed" : "patients in beds"}
              loading={inpatients.isPending && ready}
              onPress={() => router.push("/inpatients")}
            />
          ) : null}

          {canReadOrders ? (
            <EntryCard
              title="Results"
              value={String(outstanding)}
              caption={outstanding === 1 ? "test still out" : "tests still out"}
              loading={results.isPending && ready && canReadOrders}
              onPress={() => router.push("/orders")}
            />
          ) : null}
        </View>

        <SectionTitle
          title="Next"
          trailing={summary.awaitingResults > 0 ? `${String(summary.awaitingResults)} at lab` : ""}
        />

        <QueryGate
          loading={round.isPending && enabled && canReadEncounters}
          error={round.error}
          empty={preview.length === 0}
          emptyTitle="Nobody is waiting"
          emptyBody="Patients assigned to you today appear here in token order."
          loadingLabel="Loading your list…"
          onRetry={() => void round.refetch()}
        >
          <View style={styles.list}>
            {preview.map((encounter) => (
              <EncounterRow
                key={encounter.id}
                encounter={encounter}
                zone={zoneFor(encounter.branchId)}
                onPress={() =>
                  router.push({
                    pathname: "/patient/[id]",
                    params: { id: encounter.patientId, encounterId: encounter.id },
                  })
                }
              />
            ))}
          </View>
        </QueryGate>

        {!enabled && ready ? (
          <EmptyState
            title="Still signing in"
            body="Your profile is loading. This screen fills in once it arrives."
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** One entry point: a big number, a word for what it counts, and somewhere to go. */
function EntryCard({
  title,
  value,
  caption,
  onPress,
  loading,
}: {
  title: string;
  value: string;
  caption: string;
  onPress: () => void;
  loading: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${title}: ${value} ${caption}`}
      style={styles.entry}
    >
      <View style={styles.entryText}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>{title}</Text>
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          {loading ? "Loading…" : caption}
        </Text>
      </View>
      <Text style={[styles.count, { color: theme.colors.fg }]}>{loading ? "—" : value}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[4], paddingBottom: space[8] },
  heading: { gap: space[1] },
  cards: { gap: space[2] },
  entry: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  entryText: { gap: 2, flex: 1 },
  count: { ...typography.title, fontVariant: ["tabular-nums"] },
  list: { gap: space[2] },
});
