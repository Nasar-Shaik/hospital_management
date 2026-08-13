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
import { DoseRow, DoseSlotRow, StayCard, WardNoteRow } from "../../src/components/clinical/Stay";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDateTime, parseInstant } from "../../src/lib/time";
import { isFeatureUnavailable } from "../../src/lib/net/errors";
import {
  encounterClassLabel,
  encounterStatusLabel,
  encounterStatusTone,
  isLiveEncounter,
} from "../../src/clinical/encounters";
import {
  isAdmission,
  isStayOpen,
  placementFor,
  placementsByEncounter,
  sortDoses,
  summariseDoses,
  summariseSlots,
} from "../../src/clinical/ipd";
import { latestReading } from "../../src/clinical/vitals";
import { sortForReview } from "../../src/clinical/results";
import { buildTimeline } from "../../src/clinical/timeline";
import { radius, size, space, typography } from "../../src/theme/tokens";

type Segment = "overview" | "stay" | "vitals" | "results" | "timeline";

interface SegmentOption {
  key: Segment;
  label: string;
}

const OVERVIEW: SegmentOption = { key: "overview", label: "Overview" };
/** Only for an inpatient — see `segmentsFor`. */
const STAY: SegmentOption = { key: "stay", label: "Stay" };
const CLINICAL: SegmentOption[] = [
  { key: "vitals", label: "Vitals" },
  { key: "results", label: "Results" },
  { key: "timeline", label: "Timeline" },
];

/**
 * The admission's own segment — second, and ONLY for an inpatient (M2 J).
 *
 * ── IPD IS A CONTEXT OF THIS CHART, NOT A SECOND CHART ──────────────────────
 * ADR-0013 §1: the IP encounter IS the admission. A ward patient therefore gets the same identity
 * block, the same allergy banner, the same vitals, the same results and the same episode timeline;
 * what an admission adds is a location, a length of stay, a running note and a medication record,
 * and that is exactly one extra tab. A parallel "inpatient chart" would mean two places to fix
 * every clinical bug and a doctor learning the app twice.
 *
 * It sits second because on a ward round the bed and the day of stay are the orienting facts — but
 * after Overview, because the consultation note is still what the patient was admitted FOR.
 */
function segmentsFor(encounter: Encounter | undefined): SegmentOption[] {
  const inpatient = encounter !== undefined && isAdmission(encounter);
  return inpatient ? [OVERVIEW, STAY, ...CLINICAL] : [OVERVIEW, ...CLINICAL];
}

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
  const segments = segmentsFor(visit);

  /**
   * The Stay tab exists only while the chart is open on an admission. A doctor who selected it and
   * then navigated to the same patient's OPD visit would otherwise be left on a segment that is no
   * longer in the bar, rendering nothing — so the selection falls back rather than going blank.
   */
  const active = segments.some((option) => option.key === segment) ? segment : "overview";

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
          {segments.map((option) => (
            <SegmentTab
              key={option.key}
              label={option.label}
              selected={option.key === active}
              onPress={() => setSegment(option.key)}
            />
          ))}
        </View>

        {!canReadChart ? (
          <EmptyState
            title="You do not have access to the chart"
            body="Reading clinical records needs the emr:read permission. Ask an administrator if you need it."
          />
        ) : active === "overview" ? (
          <Overview patientId={patientId} encounterId={encounterId} zone={zone} />
        ) : active === "stay" && visit ? (
          <Stay encounter={visit} zone={zone} />
        ) : active === "vitals" ? (
          <Vitals patientId={patientId} encounterId={encounterId} zoneFor={zoneFor} />
        ) : active === "results" ? (
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
            {...(visit && isAdmission(visit) ? { stayId: visit.id } : {})}
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

/**
 * The admission (M2 J) — where they are, what has been written, and what has actually been given.
 *
 * ── THREE READS, THREE INDEPENDENT FAILURES ─────────────────────────────────
 * The bed board, the ward notes and the MAR each answer separately, and each is allowed to be
 * missing without taking the others with it. That is not defensive habit — they sit behind
 * DIFFERENT gates: the board and the notes behind `module.ops.ipd`, the MAR behind
 * `module.clinical.nursing`. A hospital can genuinely have wards and no nursing module, and its
 * doctors must still get the bed and the notes.
 */
function Stay({ encounter, zone }: { encounter: Encounter; zone: string }): React.JSX.Element {
  const theme = useTheme();
  const { queries, ready } = useClinical();
  const { can } = useCapabilities();

  const board = useQuery({ ...queries.bedBoard(), enabled: ready });
  const notes = useQuery({ ...queries.wardNotes(encounter.id), enabled: ready });
  const doses = useQuery({ ...queries.medications(encounter.id), enabled: ready });
  /**
   * What is DUE, as opposed to what was given (M3-S3). A separate query and a separate key: "the
   * 14:00 dose is due" and "the 14:00 dose was given" differ by exactly the thing being decided,
   * and serving one for the other would be the worst possible cache collision on this screen.
   *
   * Only for a stay that is still open — a discharged patient has no round left to run, and
   * showing yesterday's due list on a closed stay invites somebody to act on it.
   */
  const schedule = useQuery({
    ...queries.medicationSchedule(encounter.id),
    enabled: ready && isStayOpen(encounter),
  });

  const placement = placementFor(encounter, placementsByEncounter(board.data));
  // Newest first: on a round the question is what happened since yesterday, and the server returns
  // these in its own order rather than a documented one.
  const entries = [...(notes.data ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const given = sortDoses(doses.data ?? []);
  const summary = summariseDoses(given);
  const dueSummary = summariseSlots(schedule.data ?? []);

  return (
    <View style={styles.section}>
      <StayCard encounter={encounter} placement={placement} zone={zone} />

      <IpdActions encounter={encounter} />

      <SectionTitle title="Ward notes" trailing={String(entries.length)} />
      <QueryGate
        loading={notes.isPending && ready}
        error={notes.error}
        empty={entries.length === 0}
        emptyTitle="Nothing written yet"
        emptyBody="Progress notes from the ward round appear here, newest first."
        onRetry={() => void notes.refetch()}
      >
        <Card>
          {entries.map((note) => (
            <WardNoteRow key={note.id} note={note} zone={zone} />
          ))}
        </Card>
      </QueryGate>

      {/**
       * ── DUE TODAY ─────────────────────────────────────────────────────────────
       * Every state on this list is the SERVER's: `due` and `overdue` are resolved in the branch's
       * timezone against real administration rows (M3-S1). Nothing here is computed from the
       * handset clock, so a phone set to the wrong time cannot make a late antibiotic look on time.
       *
       * Read-only in S3. Charting a dose is S5, and it needs a confirmation naming the patient,
       * the drug, the dose and the route — not a tap on a scrolling list.
       */}
      {isFeatureUnavailable(schedule.error) || !isStayOpen(encounter) ? null : (
        <>
          <SectionTitle
            title="Due today"
            trailing={
              dueSummary.overdue > 0
                ? `${String(dueSummary.due)} due · ${String(dueSummary.overdue)} overdue`
                : String(dueSummary.due)
            }
          />
          <QueryGate
            loading={schedule.isPending && ready}
            error={schedule.error}
            empty={(schedule.data ?? []).length === 0}
            emptyTitle="Nothing scheduled today"
            emptyBody="Regular doses from a signed prescription appear here. As-needed drugs never do — they have no scheduled time."
            onRetry={() => void schedule.refetch()}
          >
            <Card>
              {(schedule.data ?? []).map((slot) => (
                <DoseSlotRow
                  key={`${slot.prescriptionId}:${String(slot.lineIndex)}:${slot.scheduledFor}`}
                  slot={slot}
                  zone={zone}
                />
              ))}
            </Card>
          </QueryGate>
        </>
      )}

      {/**
       * ── THE MAR IS HIDDEN WHEN THE HOSPITAL DOES NOT HAVE IT ──────────────────
       * `HMS-PLAN-002` here means `module.clinical.nursing` was not bought — a product boundary, not
       * a fault, and no role edit or retry will ever change it. An empty "Medication given" heading
       * would read as "nothing has been given to this patient", which is a clinically dangerous
       * thing to imply. Any OTHER error is reported normally, because that one is somebody's
       * misconfiguration and somebody can fix it.
       */}
      {isFeatureUnavailable(doses.error) ? null : (
        <>
          <SectionTitle
            title="Medication given"
            trailing={
              summary.missed > 0
                ? `${String(summary.given)} given · ${String(summary.missed)} not`
                : String(summary.given)
            }
          />
          <QueryGate
            loading={doses.isPending && ready}
            error={doses.error}
            empty={given.length === 0}
            emptyTitle="No doses charted"
            emptyBody="Doses recorded by nursing against a signed prescription appear here."
            onRetry={() => void doses.refetch()}
          >
            <Card>
              {given.map((dose) => (
                <DoseRow key={dose.id} dose={dose} zone={zone} />
              ))}
            </Card>
          </QueryGate>
        </>
      )}

      {!can("emr:read") ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Some of this stay needs the emr:read permission.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The two IPD writes a DOCTOR may actually make.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
 * BED TRANSFER needs `bed:allocate`, which the DOCTOR role does not hold — it is the nurse's, and
 * the permission's own description is "Allocate and transfer beds". Rendering it because the
 * endpoint exists would put a button in front of somebody whose only possible outcome is a 403.
 *
 * OUTCOME (LAMA / absconded / a death) is permitted to a doctor — same grant as discharge — and is
 * still deliberately absent. It is a statutory record written at a desk with the notes open, not a
 * tap on a round; a mis-tap closes a stay with a false disposition and there is no way back. A
 * death additionally runs through certification (`death:certify`) that this app does not implement.
 *
 * ADMIT is not round work either: it closes the OP encounter, opens the stay and starts the bed
 * charge, and it needs a bed picked off the board.
 */
function IpdActions({ encounter }: { encounter: Encounter }): React.JSX.Element | null {
  const router = useRouter();
  const { can } = useCapabilities();

  // A discharged stay is read-only. The server refuses both writes with HMS-STATE-001 ("this
  // admission is already over"); this declines to invite the refusal.
  if (!isStayOpen(encounter)) return null;

  const actions: { label: string; needs: string; go: () => void }[] = [
    {
      label: "Ward note",
      needs: "emr:write",
      go: () =>
        router.push({
          pathname: "/ward-note/[encounterId]",
          params: { encounterId: encounter.id },
        }),
    },
    {
      label: "Discharge",
      needs: "admission:discharge",
      go: () =>
        router.push({
          pathname: "/discharge/[encounterId]",
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
  stayId,
  allowedOrders,
  zoneFor,
  onOpen,
}: {
  patientId: string;
  episodeId: string | undefined;
  /** The IP encounter, when this chart is open on an admission — adds the ward's own entries. */
  stayId?: string;
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

  /**
   * The ward's entries, only for an admission. This is what makes an inpatient timeline read as a
   * sequence of days — each progress note lands at the moment it was written, interleaved with the
   * orders and results of that day, rather than the whole stay collapsing into one "Admitted" row.
   */
  const wardNotes = useQuery({
    ...queries.wardNotes(stayId ?? ""),
    enabled: ready && Boolean(stayId),
  });

  const events = buildTimeline({
    encounters: episodeId ? (episode.data ?? []) : (visits.data?.items ?? []),
    orders: orders.data?.items ?? [],
    prescriptions: prescriptions.data ?? [],
    vitals: vitals.data ?? [],
    wardNotes: wardNotes.data ?? [],
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
