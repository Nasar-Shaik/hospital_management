/**
 * The chart (M2 E, F) — identity, the visit in front of you, observations, results, and the story.
 *
 * ── ONE SCREEN WITH SEGMENTS, NOT FIVE SCREENS ──────────────────────────────
 * Minimal navigation depth is a clinical requirement, not a preference: every level between a
 * doctor and a number is a level they will skip when the ward is busy. Identity stays PINNED above
 * the segments, so whichever section is open, the name and the UHID on the wristband are on screen.
 * That is the single most effective guard against reading the right record for the wrong person.
 *
 * ── WHAT IS FETCHED IS WHAT IS BEING LOOKED AT ──────────────────────────────
 * Each segment enables its own queries. Opening a chart costs identity and allergies; the results
 * are not pulled until somebody asks for results. On hospital wifi that is the difference between a
 * screen that opens and a screen that spins.
 *
 * ── THE PARAMS CARRY RECORD IDS, NEVER A BRANCH ─────────────────────────────
 * `id` and `encounterId` come from navigation, and the server authorizes both on every request —
 * an id for a patient in another branch answers 404 (HMS-GEN-404: "may belong to another branch"),
 * which is the boundary. What is NEVER taken from a param, a push payload or storage is the ACTIVE
 * BRANCH: that comes only from the validated switcher, through the api-client's own header.
 */
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { Encounter } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Pill } from "../../src/components/Pill";
import { Button } from "../../src/components/Button";
import { QueryGate } from "../../src/components/QueryGate";
import { EmptyState } from "../../src/components/StateView";
import {
  AllergyBanner,
  PATIENT_STALE_MS,
  PatientIdentity,
} from "../../src/components/clinical/Identity";
import { VitalsCard, VitalsHistoryRow } from "../../src/components/clinical/Vitals";
import { OrderRow } from "../../src/components/clinical/Results";
import { TimelineRow } from "../../src/components/clinical/Timeline";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDateTime, parseInstant } from "../../src/lib/time";
import {
  encounterClassLabel,
  encounterStatusLabel,
  encounterStatusTone,
  isLiveEncounter,
} from "../../src/clinical/encounters";
import { latestReading } from "../../src/clinical/vitals";
import { sortForReview } from "../../src/clinical/results";
import { buildTimeline } from "../../src/clinical/timeline";
import { radius, size, space, typography } from "../../src/theme/tokens";

type Segment = "overview" | "vitals" | "results" | "timeline";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "vitals", label: "Vitals" },
  { key: "results", label: "Results" },
  { key: "timeline", label: "Timeline" },
];

function PatientChart(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; encounterId?: string }>();
  const patientId = params.id;
  const encounterId = params.encounterId;

  const [segment, setSegment] = useState<Segment>("overview");
  const { can } = useCapabilities();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();

  const canReadChart = can("emr:read");
  const canReadOrders = can("order:read");

  /**
   * ONE observer on the patient key, not two.
   *
   * `usePatient` (used by every list row) and a second `useQuery` on the same key would both
   * resolve from the same cache entry — but React Query takes the MINIMUM `staleTime` across
   * observers, so the row's deliberate five minutes would be undone by a second observer that
   * did not set one, and opening a chart would re-fetch the name it already had.
   */
  const patientQuery = useQuery({
    ...queries.patient(patientId),
    enabled: ready,
    staleTime: PATIENT_STALE_MS,
  });
  const patient = patientQuery.data;

  const allergies = useQuery({
    ...queries.allergies(patientId),
    enabled: ready && can("allergy:read"),
  });

  const encounter = useQuery({
    ...queries.encounter(encounterId ?? ""),
    enabled: ready && Boolean(encounterId),
  });

  const visit = encounter.data;
  const zone = zoneFor(visit?.branchId);

  return (
    <Screen padded={false} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={patientQuery.isRefetching}
            onRefresh={() => void patientQuery.refetch()}
            tintColor={theme.colors.brand}
          />
        }
      >
        {/* Identity first and always. Everything below it is about this person. */}
        <QueryGate
          loading={patientQuery.isPending && ready}
          error={patientQuery.error}
          emptyTitle="Patient not found"
          loadingLabel="Loading the chart…"
          onRetry={() => void patientQuery.refetch()}
        >
          {patient ? <PatientIdentity patient={patient} /> : null}
        </QueryGate>

        <AllergyBanner allergies={allergies.data} loading={allergies.isPending && ready} />

        {visit ? <VisitBanner encounter={visit} zone={zone} /> : null}

        {visit ? <ClinicalActions encounter={visit} /> : null}

        <View style={styles.segments}>
          {SEGMENTS.map((option) => (
            <SegmentTab
              key={option.key}
              label={option.label}
              selected={option.key === segment}
              onPress={() => setSegment(option.key)}
            />
          ))}
        </View>

        {!canReadChart ? (
          <EmptyState
            title="You do not have access to the chart"
            body="Reading clinical records needs the emr:read permission. Ask an administrator if you need it."
          />
        ) : segment === "overview" ? (
          <Overview patientId={patientId} encounterId={encounterId} zone={zone} />
        ) : segment === "vitals" ? (
          <Vitals patientId={patientId} encounterId={encounterId} zoneFor={zoneFor} />
        ) : segment === "results" ? (
          <Results
            patientId={patientId}
            allowed={canReadOrders}
            zoneFor={zoneFor}
            onOpen={(orderId) => router.push({ pathname: "/order/[id]", params: { id: orderId } })}
          />
        ) : (
          <Timeline
            patientId={patientId}
            episodeId={visit?.episodeId}
            allowedOrders={canReadOrders}
            zoneFor={zoneFor}
            onOpen={(orderId) => router.push({ pathname: "/order/[id]", params: { id: orderId } })}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

/** The visit this chart was opened FROM — the context that makes "latest" mean something. */
function VisitBanner({
  encounter,
  zone,
}: {
  encounter: Encounter;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const arrived = parseInstant(encounter.arrivedAt);
  return (
    <Card>
      <View style={styles.visitTop}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>
          {encounterClassLabel(encounter.class)}
          {encounter.token !== undefined ? ` · token ${String(encounter.token)}` : ""}
        </Text>
        <Pill
          label={encounterStatusLabel(encounter.status)}
          tone={encounterStatusTone(encounter.status)}
        />
      </View>
      {arrived ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Arrived {formatDateTime(arrived, zone)}
        </Text>
      ) : null}
      {encounter.bed ? (
        <Text style={[typography.body, { color: theme.colors.fg }]}>
          {encounter.bed.ward} · bed {encounter.bed.bedCode}
        </Text>
      ) : null}
      {encounter.reason ? (
        <Text style={[typography.body, { color: theme.colors.fg }]}>{encounter.reason}</Text>
      ) : null}
    </Card>
  );
}

/**
 * The three clinical writes, as explicit destinations.
 *
 * ── AN ACTION IS OFFERED ONLY WHERE IT IS MEANINGFUL ────────────────────────
 * Each needs the permission AND an open visit. Prescribing against a closed encounter is refused
 * server-side with `HMS-STATE-001` ("cannot prescribe against a closed visit"), and offering a
 * button whose only possible outcome is that refusal teaches doctors to distrust the buttons. The
 * server is still the authority — this only declines to invite a request that cannot succeed.
 *
 * They navigate. Nothing here mutates, and in particular nothing here signs: the signature lives
 * behind the review stage of the prescribing screen and is reachable from nowhere else.
 */
function ClinicalActions({ encounter }: { encounter: Encounter }): React.JSX.Element | null {
  const router = useRouter();
  const { can } = useCapabilities();
  const open = isLiveEncounter(encounter);
  if (!open) return null;

  const actions: { label: string; needs: string; go: () => void }[] = [
    {
      label: "Consultation note",
      needs: "emr:write",
      go: () =>
        router.push({
          pathname: "/consultation/[encounterId]",
          params: { encounterId: encounter.id },
        }),
    },
    {
      label: "Order tests",
      needs: "order:create",
      go: () =>
        router.push({
          pathname: "/order-pad/[encounterId]",
          params: { encounterId: encounter.id },
        }),
    },
    {
      label: "Prescribe",
      needs: "prescription:create",
      go: () =>
        router.push({
          pathname: "/prescribe/[encounterId]",
          params: { encounterId: encounter.id },
        }),
    },
  ].filter((action) => can(action.needs));

  if (actions.length === 0) return null;

  return (
    <View style={styles.actions}>
      {actions.map((action) => (
        <View key={action.label} style={styles.action}>
          <Button label={action.label} variant="secondary" onPress={action.go} />
        </View>
      ))}
    </View>
  );
}

/** The consultation note and the visit summary — what was thought, and what was decided. */
function Overview({
  patientId,
  encounterId,
  zone,
}: {
  patientId: string;
  encounterId: string | undefined;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { queries, ready } = useClinical();

  const note = useQuery({
    ...queries.consultation(encounterId ?? ""),
    enabled: ready && Boolean(encounterId),
  });
  const visits = useQuery({ ...queries.patientEncounters(patientId), enabled: ready });

  const updatedAt = parseInstant(note.data?.updatedAt);

  return (
    <View style={styles.section}>
      <SectionTitle title="Consultation note" />
      <QueryGate
        loading={note.isPending && ready && Boolean(encounterId)}
        error={note.error}
        empty={!note.data}
        emptyTitle="No note on this visit"
        emptyBody={
          encounterId
            ? "The consultation note appears here once it is written."
            : "Open this chart from a visit to see its note."
        }
        onRetry={() => void note.refetch()}
      >
        {note.data ? (
          <Card>
            <Field label="Complaint" value={note.data.chiefComplaint} />
            <Field label="History" value={note.data.history} />
            <Field label="Examination" value={note.data.examination} />
            {note.data.diagnoses.length > 0 ? (
              <View style={styles.field}>
                <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Diagnosis</Text>
                {note.data.diagnoses.map((diagnosis) => (
                  <Text
                    key={`${diagnosis.text}-${diagnosis.type}`}
                    style={[typography.body, { color: theme.colors.fg }]}
                  >
                    {diagnosis.text}
                    <Text style={{ color: theme.colors.fgSubtle }}> · {diagnosis.type}</Text>
                  </Text>
                ))}
              </View>
            ) : null}
            <Field label="Plan" value={note.data.plan} />
            {updatedAt ? (
              <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                Last written {formatDateTime(updatedAt, zone)}
              </Text>
            ) : null}
          </Card>
        ) : null}
      </QueryGate>

      <SectionTitle title="Visits" trailing={String(visits.data?.items.length ?? 0)} />
      <QueryGate
        loading={visits.isPending && ready}
        error={visits.error}
        empty={(visits.data?.items.length ?? 0) === 0}
        emptyTitle="No visits recorded"
        onRetry={() => void visits.refetch()}
      >
        <Card>
          {(visits.data?.items ?? []).map((item) => {
            const arrived = parseInstant(item.arrivedAt);
            return (
              <View key={item.id} style={styles.visitRow}>
                <Text style={[typography.body, { color: theme.colors.fg }]}>
                  {encounterClassLabel(item.class)}
                </Text>
                <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                  {arrived ? formatDateTime(arrived, zone) : "—"}
                </Text>
              </View>
            );
          })}
        </Card>
      </QueryGate>
    </View>
  );
}

function Vitals({
  patientId,
  encounterId,
  zoneFor,
}: {
  patientId: string;
  encounterId: string | undefined;
  zoneFor: (branchId?: string) => string;
}): React.JSX.Element {
  const { queries, ready } = useClinical();

  const trend = useQuery({ ...queries.patientVitals(patientId), enabled: ready });
  const thisVisit = useQuery({
    ...queries.encounterVitals(encounterId ?? ""),
    enabled: ready && Boolean(encounterId),
  });

  /**
   * "Latest" is picked by `recordedAt`, not by array position: the two endpoints document OPPOSITE
   * orders (patient trend newest-first, visit chart oldest-first), and trusting the order would
   * show the oldest observation as the newest on exactly one of them.
   *
   * The visit's own readings win when there are any — a doctor looking at a patient in front of
   * them wants what was charted at THIS triage, not a number from a visit last March.
   */
  const visitReadings = thisVisit.data ?? [];
  const trendReadings = trend.data ?? [];
  const latest = latestReading(visitReadings.length > 0 ? visitReadings : trendReadings);
  const history = trendReadings.filter((reading) => reading.id !== latest?.id);

  return (
    <View style={styles.section}>
      <QueryGate
        loading={trend.isPending && ready}
        error={trend.error}
        empty={!latest}
        emptyTitle="No observations recorded"
        emptyBody="Vitals charted by nursing appear here."
        loadingLabel="Loading observations…"
        onRetry={() => void trend.refetch()}
      >
        {latest ? (
          <VitalsCard
            reading={latest}
            zone={zoneFor(undefined)}
            heading={visitReadings.length > 0 ? "Latest — this visit" : "Latest recorded"}
          />
        ) : null}
      </QueryGate>

      {history.length > 0 ? (
        <>
          <SectionTitle title="Earlier" trailing={String(history.length)} />
          <Card>
            {history.map((reading) => (
              <VitalsHistoryRow key={reading.id} reading={reading} zone={zoneFor(undefined)} />
            ))}
          </Card>
        </>
      ) : null}
    </View>
  );
}

function Results({
  patientId,
  allowed,
  zoneFor,
  onOpen,
}: {
  patientId: string;
  allowed: boolean;
  zoneFor: (branchId?: string) => string;
  onOpen: (orderId: string) => void;
}): React.JSX.Element {
  const { queries, ready } = useClinical();
  const orders = useQuery({ ...queries.patientOrders(patientId), enabled: ready && allowed });

  if (!allowed) {
    return (
      <EmptyState
        title="You do not have access to results"
        body="Reading orders and results needs the order:read permission."
      />
    );
  }

  // Critical first, then outstanding, then the rest — a panic value from this morning must not be
  // buried under six routine results that came back since.
  const sorted = sortForReview(orders.data?.items ?? []);

  return (
    <View style={styles.section}>
      <QueryGate
        loading={orders.isPending && ready}
        error={orders.error}
        empty={sorted.length === 0}
        emptyTitle="Nothing ordered"
        emptyBody="Tests ordered for this patient appear here, with results once they are released."
        loadingLabel="Loading results…"
        onRetry={() => void orders.refetch()}
      >
        {sorted.map((order) => (
          <OrderRow
            key={order.id}
            order={order}
            zone={zoneFor(order.branchId)}
            onPress={() => onOpen(order.id)}
          />
        ))}
      </QueryGate>
    </View>
  );
}

function Timeline({
  patientId,
  episodeId,
  allowedOrders,
  zoneFor,
  onOpen,
}: {
  patientId: string;
  episodeId: string | undefined;
  allowedOrders: boolean;
  zoneFor: (branchId?: string) => string;
  onOpen: (orderId: string) => void;
}): React.JSX.Element {
  const { queries, ready } = useClinical();

  /**
   * The care story when there is one (`GET /episodes/:id/timeline`, ADR-0013 §4), otherwise the
   * patient's visits. The episode is the tighter answer — it is the continuity thread the API
   * itself models — and it is only known when the chart was opened from a visit.
   */
  const episode = useQuery({
    ...queries.episodeTimeline(episodeId ?? ""),
    enabled: ready && Boolean(episodeId),
  });
  const visits = useQuery({
    ...queries.patientEncounters(patientId),
    enabled: ready && !episodeId,
  });
  const orders = useQuery({ ...queries.patientOrders(patientId), enabled: ready && allowedOrders });
  const prescriptions = useQuery({ ...queries.prescriptions(patientId), enabled: ready });
  const vitals = useQuery({ ...queries.patientVitals(patientId), enabled: ready });

  const events = buildTimeline({
    encounters: episodeId ? (episode.data ?? []) : (visits.data?.items ?? []),
    orders: orders.data?.items ?? [],
    prescriptions: prescriptions.data ?? [],
    vitals: vitals.data ?? [],
  });

  const loading = (episodeId ? episode.isPending : visits.isPending) && ready;

  return (
    <View style={styles.section}>
      <QueryGate
        loading={loading}
        error={episodeId ? episode.error : visits.error}
        empty={events.length === 0}
        emptyTitle="Nothing recorded yet"
        emptyBody="Visits, orders, results and prescriptions appear here as they happen."
        loadingLabel="Building the timeline…"
        onRetry={() => void (episodeId ? episode.refetch() : visits.refetch())}
      >
        {events.map((event) => (
          <TimelineRow
            key={event.id}
            event={event}
            zoneFor={zoneFor}
            {...(event.orderId ? { onPress: () => onOpen(event.orderId ?? "") } : {})}
          />
        ))}
      </QueryGate>
    </View>
  );
}

function Field({ label, value }: { label: string; value?: string }): React.JSX.Element | null {
  const theme = useTheme();
  if (!value) return null;
  return (
    <View style={styles.field}>
      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{label}</Text>
      <Text style={[typography.body, { color: theme.colors.fg }]}>{value}</Text>
    </View>
  );
}

function SegmentTab({
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
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.segment,
        {
          color: selected ? theme.colors.fg : theme.colors.fgMuted,
          backgroundColor: selected ? theme.colors.bgElevated : "transparent",
          borderColor: selected ? theme.colors.borderStrong : "transparent",
        },
      ]}
    >
      {label}
    </Text>
  );
}

export default requireRuntime(PatientChart);

const styles = StyleSheet.create({
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  visitTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  segments: { flexDirection: "row", gap: space[1] },
  segment: {
    ...typography.label,
    flex: 1,
    textAlign: "center",
    minHeight: size.touchTarget - 12,
    paddingVertical: space[2],
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  section: { gap: space[2] },
  field: { gap: 2 },
  visitRow: { flexDirection: "row", justifyContent: "space-between", gap: space[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[2] },
  action: { flexGrow: 1, flexBasis: "30%" },
});
