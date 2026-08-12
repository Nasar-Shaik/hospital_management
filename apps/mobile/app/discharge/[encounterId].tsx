/**
 * Ending the stay (M2 J) — the most consequential write in this app.
 *
 * ── WHAT ONE TAP DOES ───────────────────────────────────────────────────────
 * Writes the discharge summary, closes the encounter, frees the bed, emits `patient.discharged`
 * and posts every bed-day not yet billed. There is no un-discharge. So it is a two-stage screen:
 * the summary is composed, and then it is confirmed against a plain statement of what will happen.
 * A single button that did all of that on one press would be the wrong shape for the act.
 *
 * ── THE SUMMARY IS NOT PAPERWORK ────────────────────────────────────────────
 * The ward-note model says it plainly: it is "the ONLY thing the next doctor to see this patient is
 * likely to read, and for a patient who goes back to a village clinic it is the entire medical
 * record of the stay." The API gives no way to discharge without one, and this screen does not try
 * to make writing one feel optional — the field is large, it leads, and the confirmation shows it
 * back before anything is sent.
 *
 * ── RETRY IS SAFE, AND THE FAILURE MODE IS A FALSE ERROR ────────────────────
 * The endpoint has no idempotency key, but two server-side guards make a second attempt refuse
 * rather than repeat: the stay is already closed, or it already has a summary. What that leaves is
 * a lost RESPONSE reading as a failure for something that worked — so every ambiguous ending goes
 * through `attemptDischarge`, which asks the encounter itself. See `clinical/discharge.ts`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * The non-routine endings — left against advice, absconded, a death. A doctor holds the permission
 * for them (`admission:discharge` covers both doors), and they are still absent: each writes a
 * permanent statutory record of something that went wrong, none is reversible, and a death runs
 * through a certification this app does not implement. They belong at a desk with the notes open,
 * not behind a thumb on a ward round.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { EmptyState } from "../../src/components/StateView";
import { StayCard } from "../../src/components/clinical/Stay";
import { PatientIdentity } from "../../src/components/clinical/Identity";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useUnsavedChanges,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDayKey } from "../../src/lib/time";
import { toUserMessage } from "../../src/lib/net/errors";
import type { DischargeInput, DischargeOutcome } from "../../src/clinical/discharge";
import { isStayOpen, placementFor, placementsByEncounter } from "../../src/clinical/ipd";
import { space, typography } from "../../src/theme/tokens";

/** Compose, then confirm. The signature of the act is the second stage and nothing else reaches it. */
type Stage = "compose" | "confirm";

function Discharge(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("admission:discharge");

  const [stage, setStage] = useState<Stage>("compose");
  const [text, setText] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [advice, setAdvice] = useState("");
  const [followUpOn, setFollowUpOn] = useState("");
  const [outcome, setOutcome] = useState<DischargeOutcome | undefined>(undefined);

  const encounter = useQuery({ ...queries.encounter(encounterId), enabled: ready });
  const board = useQuery({ ...queries.bedBoard(), enabled: ready });
  const visit = encounter.data;
  const patient = useQuery({
    ...queries.patient(visit?.patientId ?? ""),
    enabled: ready && Boolean(visit?.patientId),
  });

  const zone = zoneFor(visit?.branchId);

  const write = useClinicalWrite(mutations.discharge(encounterId), {
    onSuccess: (result) => setOutcome(result),
  });

  const written = text.trim();
  const dirty = written.length > 0 && outcome?.outcome !== "discharged";
  useUnsavedChanges(dirty, "discharge summary");

  const input: DischargeInput = {
    text: written,
    ...(diagnosis.trim() ? { diagnosis: diagnosis.trim() } : {}),
    ...(advice.trim() ? { advice: advice.trim() } : {}),
    ...(followUpOn ? { followUpOn } : {}),
  };

  const fieldErrors =
    write.error instanceof ApiClientError
      ? write.error.fieldErrors
      : ({} as Record<string, string[]>);

  // The stay ended — either we just did it, or somebody else did while this screen was open.
  const ended = outcome?.outcome === "discharged" || (visit !== undefined && !isStayOpen(visit));

  if (visit && visit.class !== "IP") {
    return (
      <Screen>
        <EmptyState
          title="This patient is not admitted"
          body="An outpatient visit is closed rather than discharged. There is nothing to discharge here."
        />
      </Screen>
    );
  }

  if (ended) {
    return (
      <Screen>
        <Done outcome={outcome} onDone={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <QueryGate
            loading={encounter.isPending && ready}
            error={encounter.error}
            emptyTitle="Stay unavailable"
            loadingLabel="Loading the stay…"
            onRetry={() => void encounter.refetch()}
          >
            {patient.data ? <PatientIdentity patient={patient.data} /> : null}
            {visit ? (
              <StayCard
                encounter={visit}
                placement={placementFor(visit, placementsByEncounter(board.data))}
                zone={zone}
              />
            ) : null}
          </QueryGate>

          {stage === "compose" ? (
            <>
              <TextField
                label="Discharge summary"
                value={text}
                onChangeText={setText}
                placeholder="What was found, what was done, how the patient was on leaving"
                multiline
                hint="This is the record the next doctor reads. It goes home with the patient."
                errors={fieldErrors.text}
              />
              <TextField
                label="Diagnosis"
                value={diagnosis}
                onChangeText={setDiagnosis}
                placeholder="Optional"
                errors={fieldErrors.diagnosis}
              />
              <TextField
                label="Advice on discharge"
                value={advice}
                onChangeText={setAdvice}
                placeholder="What to do at home — medication, warning signs, activity"
                multiline
                errors={fieldErrors.advice}
              />
              <TextField
                label="Follow up on"
                value={followUpOn}
                onChangeText={setFollowUpOn}
                placeholder="YYYY-MM-DD"
                /**
                 * The suggestion is the hospital's today, not the phone's. A doctor on call from
                 * another timezone typing "today" must mean the ward's today — the same reason
                 * every clinical instant on this screen is rendered in the branch's zone.
                 */
                hint={`Optional. Today at this branch is ${formatDayKey(new Date(), zone)}.`}
                autoCapitalize="none"
                errors={fieldErrors.followUpOn}
              />
            </>
          ) : (
            <Confirmation input={input} />
          )}
        </ScrollView>

        <View
          style={[
            styles.bar,
            { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
          ]}
        >
          <Status outcome={outcome} saving={write.isPending} error={write.error} />

          {stage === "compose" ? (
            <Button
              label="Review the discharge"
              disabled={!guard.canWrite || written.length === 0}
              reason={
                guard.reason ?? (written.length === 0 ? "Write the summary first." : undefined)
              }
              onPress={() => setStage("confirm")}
            />
          ) : (
            <View style={styles.confirmRow}>
              <View style={styles.grow}>
                <Button
                  label="Back to editing"
                  variant="secondary"
                  disabled={write.isPending}
                  onPress={() => setStage("compose")}
                />
              </View>
              <View style={styles.grow}>
                <Button
                  label={write.isPending ? "Discharging…" : "Discharge patient"}
                  // The one irreversible act in this slice, and the only place `danger` is spent.
                  variant="danger"
                  loading={write.isPending}
                  disabled={!guard.canWrite || write.isPending}
                  reason={guard.reason}
                  onPress={() => {
                    setOutcome(undefined);
                    write.mutate(input);
                  }}
                />
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** What is about to happen, and what the patient will be given — read back before it is sent. */
function Confirmation({ input }: { input: DischargeInput }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <View
        accessibilityRole="alert"
        style={[
          styles.warning,
          { backgroundColor: theme.colors.warningBg, borderColor: theme.colors.warning },
        ]}
      >
        <Text style={[typography.label, { color: theme.colors.warning }]}>THIS ENDS THE STAY</Text>
        <Text style={[typography.body, { color: theme.colors.fg }]}>
          The bed is freed, the stay closes and the bed-days are billed. This cannot be undone.
        </Text>
      </View>

      <SectionTitle title="Summary" />
      <Card>
        <Text style={[typography.body, { color: theme.colors.fg }]}>{input.text}</Text>
      </Card>

      {input.diagnosis ? <Detail label="Diagnosis" value={input.diagnosis} /> : null}
      {input.advice ? <Detail label="Advice" value={input.advice} /> : null}
      {input.followUpOn ? <Detail label="Follow up on" value={input.followUpOn} /> : null}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      <SectionTitle title={label} />
      <Card>
        <Text style={[typography.body, { color: theme.colors.fg }]}>{value}</Text>
      </Card>
    </>
  );
}

/**
 * The three endings that are not a plain success, said in words a doctor can act on.
 *
 * `incomplete` is the one worth reading twice: the summary was written and the stay did not close,
 * so pressing again can NEVER work — the server's own summary guard will refuse it every time. Any
 * message ending in "try again" would send the doctor into a loop, so this one does not offer a
 * retry at all and says who to call instead.
 */
function Status({
  outcome,
  saving,
  error,
}: {
  outcome: DischargeOutcome | undefined;
  saving: boolean;
  error: unknown;
}): React.JSX.Element | null {
  const theme = useTheme();

  if (saving) {
    return <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Discharging…</Text>;
  }

  if (error !== null && error !== undefined && !outcome) {
    const message = toUserMessage(error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not discharged" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>{message.body}</Text>
      </View>
    );
  }

  if (outcome?.outcome === "incomplete") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Needs the ward's help" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          The summary was written but the stay did not close, so the patient still shows as
          occupying the bed. Trying again will not fix this — tell the ward clerk or your
          administrator, and quote this patient&apos;s bed.
        </Text>
      </View>
    );
  }

  if (outcome?.outcome === "notDischarged") {
    const message = toUserMessage(outcome.error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not discharged" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {message.body} The stay was checked and it is still open — your summary is still here, so
          you can try again.
        </Text>
      </View>
    );
  }

  if (outcome?.outcome === "failed") {
    const message = toUserMessage(outcome.error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not discharged" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>{message.body}</Text>
      </View>
    );
  }

  return null;
}

/** The stay is over — either we just ended it, or it was already over when this screen opened. */
function Done({
  outcome,
  onDone,
}: {
  outcome: DischargeOutcome | undefined;
  onDone: () => void;
}): React.JSX.Element {
  const reconciled = outcome?.outcome === "discharged" && outcome.reconciled;
  return (
    <View style={styles.section}>
      <EmptyState
        title="The stay is over"
        body={
          reconciled
            ? "The connection dropped before the confirmation arrived, so this was checked against the record. The patient was discharged successfully — it did not happen twice."
            : outcome
              ? "The summary is on the chart and the bed is free."
              : "This admission has already been closed."
        }
      />
      <Button label="Back to the chart" variant="secondary" onPress={onDone} />
    </View>
  );
}

export default requireRuntime(Discharge);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  bar: { borderTopWidth: 1, padding: space[4], gap: space[2] },
  section: { gap: space[2] },
  status: { gap: space[1] },
  warning: { borderWidth: 1, borderRadius: 12, padding: space[3], gap: space[1] },
  confirmRow: { flexDirection: "row", gap: space[2] },
  grow: { flex: 1 },
});
