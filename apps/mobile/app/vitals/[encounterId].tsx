/**
 * Charting observations at the bedside (M3-S4) — the nurse's first clinical write.
 *
 * ── ENTER, THEN REVIEW, THEN COMMIT ─────────────────────────────────────────
 * Two stages, not one form with a save button, and not a confirmation dialog per field. A vitals
 * record is append-only and permanent: there is no update path and no delete path in the
 * repository, so a mis-keyed pulse is on the chart for good and is corrected only by charting the
 * right one beside it. The review stage exists to make ONE deliberate check possible — the patient,
 * the visit, the figures, the units — at the moment it is still free to go back. Per-field
 * confirmations would be dismissed unread by the third bed; one review before a permanent record
 * is read.
 *
 * ── WHAT THIS SCREEN DOES NOT DECIDE ────────────────────────────────────────
 * Nothing clinical. It checks that a figure is PLAUSIBLE (a typo guard, mirroring the server's own
 * bounds) and stops there. Whether a value is high, low or normal is the API's `assess()`, painted
 * only AFTER the save, from the server's response. There is no local reference range anywhere in
 * this file, and a test scans for one.
 *
 * ── NO OFFLINE QUEUE (M0 §11) ───────────────────────────────────────────────
 * Offline the button is disabled with a reason and the figures stay on screen. Nothing is promised
 * and nothing is stored. A queued observation would land at a time nobody chose, stamped by the
 * server long after the cuff came off, against a patient who may have been discharged.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, type VitalsReading } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { EmptyState } from "../../src/components/StateView";
import { VitalsCard } from "../../src/components/clinical/Vitals";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useCapabilities } from "../../src/hooks/useStores";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useIntentKeys,
  useUnsavedChanges,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useTheme } from "../../src/hooks/useTheme";
import { toUserMessage } from "../../src/lib/net/errors";
import { isStayOpen } from "../../src/clinical/ipd";
import { latestReading } from "../../src/clinical/vitals";
import {
  ENTRY_ORDER,
  FIELD_RULES,
  canSubmit,
  isDirty,
  problemsByField,
  problemsFor,
  reviewLines,
  toPayload,
  type VitalsDraft,
} from "../../src/clinical/vitalsEntry";
import type { VitalsOutcome } from "../../src/clinical/vitalsWrite";
import { radius, size, space, typography } from "../../src/theme/tokens";

type Stage = "enter" | "review";

function VitalsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready, userId } = useClinical();
  const zoneFor = useZoneFor();
  const { can } = useCapabilities();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("vitals:record");

  const [draft, setDraft] = useState<VitalsDraft>({});
  const [stage, setStage] = useState<Stage>("enter");
  const [outcome, setOutcome] = useState<VitalsOutcome | undefined>(undefined);

  /**
   * Context and the existing chart, on the SAME keys the patient chart uses.
   *
   * Arriving here from the chart therefore costs nothing: React Query serves all three from cache
   * and revalidates in the background. Inventing screen-local keys would turn one tap into three
   * fresh round trips on ward wifi for data already in hand.
   */
  const encounter = useQuery({ ...queries.encounter(encounterId), enabled: ready });
  const visit = encounter.data;
  const patient = useQuery({
    ...queries.patient(visit?.patientId ?? ""),
    enabled: ready && Boolean(visit?.patientId),
  });
  const readings = useQuery({ ...queries.encounterVitals(encounterId), enabled: ready });

  /**
   * ── THE SNAPSHOT IS THE WHOLE RECONCILIATION ────────────────────────────────
   * The visit's readings as this screen has them RIGHT NOW. After an ambiguous failure the
   * reconciler re-reads and looks for one that is not in this set — a set difference on ids, so it
   * needs no clock and cannot mistake a colleague's identical pulse for ours.
   *
   * `undefined` — never loaded, or failed — deliberately DISABLES the "saved" conclusion.
   */
  const before: readonly VitalsReading[] | undefined = readings.isSuccess
    ? readings.data
    : undefined;

  /**
   * One key for one set of observations, stable across its retries.
   *
   * `keyFor("vitals")` returns the same string until `reset()`, which happens only once a reading
   * has landed. Pressing save again after a failure therefore REPLAYS the first attempt
   * server-side rather than charting a second set, while the next patient's observations are a
   * genuinely new intent with a new key. Minting per press would defeat the mechanism entirely.
   */
  const keys = useIntentKeys();

  const write = useClinicalWrite(
    mutations.recordVitals(encounterId, {
      before,
      key: keys.keyFor("vitals"),
      ...(userId ? { recordedBy: userId } : {}),
    }),
    {
      onSuccess: (result) => {
        setOutcome(result);
        if (result.outcome === "saved") {
          // Confirmed by the server. The form empties, the key retires, and the next set of
          // observations on this patient is a new intent.
          setDraft({});
          setStage("enter");
          keys.reset();
        } else {
          // Not saved, or not known to be. The figures stay exactly as typed and the nurse stays
          // on the review stage, where the retry button is.
          setStage("review");
        }
      },
    },
  );

  const problems = problemsFor(draft);
  const fieldProblems = problemsByField(problems);
  const dirty = isDirty(draft);
  useUnsavedChanges(dirty, "set of observations");

  /**
   * The visit's own zone, not the reader's. A nurse covering a second site sees a 22:00
   * observation stamped 22:00, which is when it was taken.
   */
  const zone = zoneFor(visit?.branchId);
  const latest = latestReading(readings.data ?? []);

  /** Server field errors, merged onto the same boxes the local ones use. */
  const serverErrors =
    write.error instanceof ApiClientError
      ? write.error.fieldErrors
      : ({} as Record<string, string[]>);

  if (!can("vitals:record")) {
    return (
      <Screen>
        <EmptyState
          title="Not available to you"
          body="Recording observations needs the vitals:record permission. Ask an administrator if you need it."
        />
      </Screen>
    );
  }

  /**
   * A finished visit takes no new observations from a bedside.
   *
   * `isStayOpen` rather than `isLiveEncounter`: an admitted patient's status is `admitted`, which
   * is deliberately NOT in the doctor's "live" set, and refusing to chart observations on every
   * inpatient in the hospital would be a spectacular way to fail. This asks the only question that
   * matters — has this episode ended.
   *
   * The SERVER refuses nothing here: vitals may be charted against any encounter the caller can
   * reach, including a finished one, because a paper chart caught up at a desk is a real workflow.
   * A phone offering it at a bedside is almost always the wrong patient selected, so this declines
   * to invite it rather than claiming it is impossible.
   */
  const closed = visit !== undefined && !isStayOpen(visit);

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Who this is. Pinned above everything, on both stages — the single most effective
              guard against charting the right numbers on the wrong patient. */}
          <Card>
            <Text style={[typography.heading, { color: theme.colors.fg }]}>
              {patient.data?.name ?? "Loading patient…"}
            </Text>
            <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
              {patient.data?.uhid ? `UHID ${patient.data.uhid}` : "—"}
              {visit?.bed ? ` · ${visit.bed.ward} · bed ${visit.bed.bedCode}` : ""}
            </Text>
          </Card>

          {closed ? (
            <Card>
              <Pill label="Visit closed" tone="warning" />
              <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
                This stay has ended. Observations belong on the patient&apos;s current visit.
              </Text>
            </Card>
          ) : null}

          {stage === "enter" ? (
            <EnterStage
              draft={draft}
              onChange={setDraft}
              fieldProblems={fieldProblems}
              serverErrors={serverErrors}
              latest={latest}
              zone={zone}
              loadingLatest={readings.isPending && ready}
            />
          ) : (
            <ReviewStage
              draft={draft}
              outcome={outcome}
              error={write.error}
              saving={write.isPending}
            />
          )}
        </ScrollView>

        <View
          style={[
            styles.bar,
            { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
          ]}
        >
          {stage === "enter" ? (
            <>
              <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                Leave a box blank if it was not measured.
              </Text>
              <Button
                label="Review"
                disabled={!canSubmit(draft) || closed}
                reason={
                  closed
                    ? "This visit is closed."
                    : problems.length > 0
                      ? "Check the highlighted figures first."
                      : !canSubmit(draft)
                        ? "Enter at least one observation."
                        : undefined
                }
                onPress={() => {
                  setOutcome(undefined);
                  setStage("review");
                }}
              />
            </>
          ) : (
            <>
              <WriteStatus
                outcome={outcome}
                saving={write.isPending}
                error={write.error}
                onDone={() => router.back()}
              />
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button
                    label="Back"
                    variant="secondary"
                    disabled={write.isPending}
                    onPress={() => setStage("enter")}
                  />
                </View>
                <View style={styles.action}>
                  <Button
                    label={write.isPending ? "Saving…" : "Save to the chart"}
                    loading={write.isPending}
                    disabled={!guard.canWrite || !canSubmit(draft) || write.isPending}
                    reason={guard.reason}
                    onPress={() => {
                      setOutcome(undefined);
                      write.mutate(toPayload(draft));
                    }}
                  />
                </View>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The boxes.
 *
 * Every field carries its unit in the LABEL rather than as adornment inside the input, so a screen
 * reader announces "Temperature, degrees Celsius" when focus lands rather than reading a bare
 * number field. `keyboardType` is chosen per field: decimal where the domain has decimals, numeric
 * where the server takes an integer — a nurse should not be offered a decimal point for a pulse.
 */
function EnterStage({
  draft,
  onChange,
  fieldProblems,
  serverErrors,
  latest,
  zone,
  loadingLatest,
}: {
  draft: VitalsDraft;
  onChange: (next: VitalsDraft) => void;
  fieldProblems: Partial<Record<string, string[]>>;
  serverErrors: Record<string, string[]>;
  latest: VitalsReading | undefined;
  zone: string;
  loadingLatest: boolean;
}): React.JSX.Element {
  const theme = useTheme();

  return (
    <>
      {/* What was last charted, for context — and it is the SERVER's assessment being painted,
          flags and all. Read-only: this is the previous observation, not a starting point to edit.
          Nothing here is copied into the boxes, because carrying yesterday's weight forward is how
          a number nobody measured ends up in a chart. */}
      <SectionTitle title="Last recorded" />
      <QueryGate
        loading={loadingLatest}
        // Not fatal. If the previous reading cannot be loaded the nurse can still chart a new one
        // — losing the context must never block the write it was there to inform.
        error={undefined}
        empty={!latest}
        emptyTitle="Nothing charted on this visit"
        emptyBody="These will be the first observations on this stay."
      >
        {latest ? <VitalsCard reading={latest} zone={zone} heading="Last recorded" /> : null}
      </QueryGate>

      <SectionTitle title="New observations" />
      <Card>
        {ENTRY_ORDER.map((field) => {
          const rule = FIELD_RULES[field];
          const errors = [...(fieldProblems[field] ?? []), ...(serverErrors[field] ?? [])];
          return (
            <TextField
              key={field}
              label={`${rule.label} (${rule.unit})`}
              value={draft[field] ?? ""}
              onChangeText={(text) => {
                onChange({ ...draft, [field]: text });
              }}
              keyboardType={rule.decimals ? "decimal-pad" : "number-pad"}
              inputMode={rule.decimals ? "decimal" : "numeric"}
              returnKeyType="next"
              placeholder="—"
              {...(errors.length > 0 ? { errors } : {})}
            />
          );
        })}
      </Card>

      <SectionTitle title="Priority" />
      <Card>
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          How sick the patient looks to you. Optional, and not a clinical score.
        </Text>
        <View style={styles.chips}>
          {(["routine", "urgent", "critical"] as const).map((level) => (
            <TriageChip
              key={level}
              level={level}
              selected={draft.triageLevel === level}
              onPress={() => {
                onChange({
                  ...draft,
                  // Tapping the selected chip clears it — "not set" must stay reachable, or a
                  // mis-tap becomes a triage level nobody meant to assign.
                  ...(draft.triageLevel === level
                    ? { triageLevel: undefined }
                    : { triageLevel: level }),
                });
              }}
            />
          ))}
        </View>
      </Card>

      <TextField
        label="Note"
        value={draft.notes ?? ""}
        onChangeText={(text) => {
          onChange({ ...draft, notes: text });
        }}
        placeholder="Optional — e.g. taken after walking, left arm"
        multiline
        hint="Anything that changes how these figures should be read."
        {...(serverErrors.notes ? { errors: serverErrors.notes } : {})}
      />
    </>
  );
}

function TriageChip({
  level,
  selected,
  onPress,
}: {
  level: "routine" | "urgent" | "critical";
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Priority ${level}`}
      onPress={onPress}
      style={[
        typography.caption,
        styles.chip,
        {
          color: selected ? theme.colors.brandStrong : theme.colors.fgSubtle,
          backgroundColor: theme.colors.bgSubtle,
          // Selection is carried by the border and the label colour and announced through
          // `accessibilityState` — never by fill alone.
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      {level}
    </Text>
  );
}

/**
 * The review.
 *
 * ── IT RENDERS THE PAYLOAD, NOT THE FORM ────────────────────────────────────
 * `reviewLines` is built from `toPayload`, so what the nurse confirms is literally what will be
 * sent — a box the parser dropped cannot appear here and be confirmed into a record that never
 * receives it. Units are on every line.
 */
function ReviewStage({
  draft,
  outcome,
  error,
  saving,
}: {
  draft: VitalsDraft;
  outcome: VitalsOutcome | undefined;
  error: unknown;
  saving: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const lines = reviewLines(draft);

  return (
    <>
      <SectionTitle title="Check before saving" />
      <Card>
        {lines.map((line) => (
          <View key={line.label} style={styles.reviewRow}>
            <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{line.label}</Text>
            <Text style={[typography.body, styles.reviewValue, { color: theme.colors.fg }]}>
              {line.value}
            </Text>
          </View>
        ))}
      </Card>

      <Text style={[typography.caption, styles.warning, { color: theme.colors.fgSubtle }]}>
        Saved with your name and the time. Observations cannot be edited afterwards — a correction
        is a new set.
      </Text>

      {/* The saved reading, with the server's own flags. This is the FIRST point at which any
          value on this screen is called high or low, and the words come from the API. */}
      {outcome?.outcome === "saved" && !saving ? (
        <>
          <SectionTitle title="On the chart" />
          <Card>
            <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
              {outcome.reading.abnormal
                ? "Recorded. One or more values are outside the adult reference range — shown on the chart."
                : "Recorded."}
            </Text>
          </Card>
        </>
      ) : null}

      {error !== null && error !== undefined && !outcome ? (
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {toUserMessage(error).body}
        </Text>
      ) : null}
    </>
  );
}

/**
 * What happened, said plainly — and never "saved" about something we did not confirm.
 *
 * The reconciled case gets its own sentence rather than a tick. A nurse whose phone showed a
 * spinner and then a failure needs to be TOLD that the app went and checked the chart and the
 * observations are on it; otherwise they chart them again, which is the exact duplicate the
 * reconciliation exists to prevent.
 *
 * The uncertain case never says "failed". It says the outcome is unknown and names the one action
 * that is safe — pressing save again replays the same key, so it cannot chart a second set.
 */
function WriteStatus({
  outcome,
  saving,
  error,
  onDone,
}: {
  outcome: VitalsOutcome | undefined;
  saving: boolean;
  error: unknown;
  onDone: () => void;
}): React.JSX.Element | null {
  const theme = useTheme();

  if (saving) {
    return <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Saving…</Text>;
  }

  if (outcome?.outcome === "saved") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Saved" tone="done" />
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          {outcome.reconciled
            ? "The connection dropped, but the chart was checked — these observations are recorded, once."
            : "Recorded on the chart."}
        </Text>
        <Button label="Done" variant="secondary" onPress={onDone} />
      </View>
    );
  }

  if (outcome?.outcome === "notSaved") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not confirmed" tone="warning" />
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          We could not confirm whether these observations were saved. Your figures are still here —
          press save again; it cannot record them twice.
        </Text>
      </View>
    );
  }

  if (outcome?.outcome === "failed") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {toUserMessage(outcome.error).body} Your figures are still here.
        </Text>
      </View>
    );
  }

  // The mutation itself rejecting — the reconciliation resolves rather than throwing, so this is
  // the unexpected path and it is reported generically rather than interpreted.
  if (error !== null && error !== undefined) {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {toUserMessage(error).body} Your figures are still here.
        </Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: space[4], gap: space[3] },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, padding: space[4], gap: space[2] },
  status: { gap: space[2] },
  actions: { flexDirection: "row", gap: space[2] },
  action: { flex: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[2], marginTop: space[2] },
  chip: {
    borderRadius: radius.full,
    minHeight: size.touchTarget,
    lineHeight: size.touchTarget,
    paddingHorizontal: space[4],
    overflow: "hidden",
  },
  reviewRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[4],
    paddingVertical: space[1],
  },
  reviewValue: { fontVariant: ["tabular-nums"] },
  warning: { paddingHorizontal: space[1] },
});

export default requireRuntime(VitalsScreen);
