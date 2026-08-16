/**
 * Answering one scheduled dose (M3-S5A) — the confirmation before an irreversible clinical act.
 *
 * ── THE SLOT ARRIVES AS A REFERENCE AND IS RE-READ AS A FACT ────────────────
 * Navigation carries `prescriptionId`, `lineIndex` and `scheduledFor` — the identity S1
 * established — and nothing else. Not the drug name, not the dose, not whether it is still due.
 * Everything shown here is re-fetched from `GET …/medication-schedule` and matched on that triple,
 * because a params bundle is a claim about the world made when the previous screen rendered, and
 * the world moves: another nurse may have given this dose in the seconds since.
 *
 * That re-read is also what makes the concurrent case work. Two nurses can hold this screen at
 * once; the loser gets `HMS-MAR-001` from the database and is shown who won, rather than a generic
 * failure that invites them to try again.
 *
 * ── WHAT THIS SCREEN IS NOT ALLOWED TO DO ───────────────────────────────────
 * It does not decide whether a dose is due (the server does, in the ward's zone), whether a slot
 * is free (the unique index does), or whether a drug is safe for this patient (nothing does — the
 * allergy panel is context for a human, not a decision). It shows facts and sends one request.
 *
 * ── NO OFFLINE, AND NO OPTIMISM ─────────────────────────────────────────────
 * Offline the button is disabled with a reason. Nothing is ever rendered as given before the
 * server says so: a MAR that briefly shows a dose that was not charted is a MAR nobody can trust.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { DoseSlot } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { EmptyState } from "../../src/components/StateView";
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
import { toUserMessage, isFeatureUnavailable } from "../../src/lib/net/errors";
import { formatDateTime, formatTime, parseInstant } from "../../src/lib/time";
import {
  doseStateLabel,
  doseStateTone,
  marStatusLabel,
  marStatusTone,
} from "../../src/clinical/ipd";
import {
  OUTCOMES,
  actorLabel,
  canConfirm,
  findSlot,
  isOpen,
  isOwnAnswer,
  outcomeOption,
  reviewLines,
  type AdministerOutcome,
  type AdministerResult,
  type SlotRef,
} from "../../src/clinical/marAdminister";
import { size, space, typography } from "../../src/theme/tokens";

function AdministerScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    encounterId: string;
    prescriptionId: string;
    lineIndex: string;
    scheduledFor: string;
  }>();
  const { encounterId } = params;

  const { queries, ready, userId } = useClinical();
  const zoneFor = useZoneFor();
  const { can } = useCapabilities();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("mar:administer");

  const [outcome, setOutcome] = useState<AdministerOutcome>("given");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<AdministerResult | undefined>(undefined);

  /** The identity from navigation — a reference to look up, never a source of clinical fact. */
  const ref: SlotRef = {
    prescriptionId: params.prescriptionId,
    lineIndex: Number(params.lineIndex),
    scheduledFor: params.scheduledFor,
  };

  /**
   * Context and the schedule, on the SAME keys the chart uses — arriving from the chart costs no
   * new requests. The schedule is the slot oracle and is deliberately re-read here rather than
   * trusted from params.
   */
  const encounter = useQuery({ ...queries.encounter(encounterId), enabled: ready });
  const visit = encounter.data;
  const patient = useQuery({
    ...queries.patient(visit?.patientId ?? ""),
    enabled: ready && Boolean(visit?.patientId),
  });
  /**
   * Hospital-wide, and it must stay that way: the allergy key carries no branch (S3/S4), because
   * an allergy recorded at one site must be visible when prescribing at another.
   */
  const allergies = useQuery({
    ...queries.allergies(visit?.patientId ?? ""),
    enabled: ready && Boolean(visit?.patientId) && can("allergy:read"),
  });
  const schedule = useQuery({ ...queries.medicationSchedule(encounterId), enabled: ready });

  const slot = findSlot(schedule.data, ref);
  const zone = zoneFor(visit?.branchId);
  const scheduledAt = parseInstant(ref.scheduledFor);
  /** In the WARD's zone. A dose time in the reader's own zone is the bug this avoids. */
  const scheduledLabel = scheduledAt ? formatDateTime(scheduledAt, zone) : ref.scheduledFor;

  /**
   * One key per DECISION, not per dose.
   *
   * Give, Hold, Refuse and Not-available are four different answers. Sharing a key across them
   * would mean that changing your mind after a lost response replays the FIRST decision — the
   * record would say the opposite of what the nurse chose, which is worse than either outcome
   * alone. `keyFor(outcome)` is parameterised by the outcome itself, so this holds for every entry
   * in `OUTCOMES` without a list to maintain. Keying by outcome also keeps each one stable across
   * its own retries, which is what makes a lost response safe.
   */
  const keys = useIntentKeys();

  const write = useClinicalWrite(
    mutations.administerDose(encounterId, { ref, key: keys.keyFor(outcome) }),
    {
      onSuccess: (settled) => {
        setResult(settled);
        // The key retires only once the slot is definitively answered. After an `unknown` it must
        // be REUSED, so that pressing confirm again is a replay rather than a second dose.
        if (settled.outcome === "recorded" || settled.outcome === "alreadyAnswered") keys.reset();
      },
    },
  );

  /** The slot is definitively answered — by this attempt, or by whoever got here first. */
  const settled =
    result?.outcome === "recorded" || result?.outcome === "alreadyAnswered" ? result : undefined;

  /**
   * ── ASKED ONLY WHEN THERE IS SOMETHING TO LOSE ────────────────────────────
   * The hold reason goes into the medico-legal record verbatim, so it is typed clinical text and
   * must be protected — but this screen also has an explicit Cancel, and guarding unconditionally
   * would put "discard your changes?" in front of the button whose entire meaning is "discard".
   * That trains people to dismiss dialogs, on the most safety-critical screen in the app.
   *
   * So the guard is bound to the reason actually having content, and it drops away once the slot
   * is settled — at which point Done is the intended exit and there is nothing unsaved left.
   */
  useUnsavedChanges(!settled && reason.trim().length > 0, "reason");

  if (!can("mar:administer")) {
    return (
      <Screen>
        <EmptyState
          title="Not available to you"
          body="Recording a dose needs the mar:administer permission. Ask an administrator if you need it."
        />
      </Screen>
    );
  }

  /**
   * `HMS-PLAN-002` means `module.clinical.nursing` was not bought — a product boundary no role edit
   * can change. Saying so is honest; an empty screen would read as "there is nothing to give".
   */
  if (isFeatureUnavailable(schedule.error)) {
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
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* WHO. First, always, and by name AND identifier — never by bed. A bed is where
              somebody was an hour ago; the wristband is what the nurse checks against. */}
          <Card>
            <Text style={[typography.heading, { color: theme.colors.fg }]}>
              {patient.data?.name ?? "Loading patient…"}
            </Text>
            <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
              {patient.data?.uhid ? `UHID ${patient.data.uhid}` : "UHID not loaded"}
              {visit?.bed ? ` · ${visit.bed.ward} · bed ${visit.bed.bedCode}` : ""}
            </Text>
          </Card>

          <AllergyContext
            allergens={(allergies.data ?? []).map((a) => a.allergen)}
            severe={(allergies.data ?? []).some((a) => a.severity === "severe")}
            allowed={can("allergy:read")}
            loading={allergies.isPending && ready}
          />

          <QueryGate
            loading={schedule.isPending && ready}
            error={schedule.error}
            empty={!slot}
            emptyTitle="This dose is no longer on today's schedule"
            emptyBody="The order may have been stopped, or the ward day may have rolled over. Go back and open the round again."
            onRetry={() => void schedule.refetch()}
          >
            {slot ? (
              <>
                <DoseCard slot={slot} scheduledLabel={scheduledLabel} />

                {settled ? (
                  <Settled result={settled} meId={userId} zone={zone} />
                ) : isOpen(slot) ? (
                  <Compose
                    slot={slot}
                    outcome={outcome}
                    onOutcome={(next) => {
                      setOutcome(next);
                      // A fresh decision clears the previous attempt's verdict; the reason is kept
                      // because it usually still applies ("systolic 84" holds for hold or refuse).
                      setResult(undefined);
                    }}
                    reason={reason}
                    onReason={setReason}
                    patientName={patient.data?.name}
                    uhid={patient.data?.uhid}
                    scheduledLabel={scheduledLabel}
                  />
                ) : (
                  /* Already answered when the screen loaded — another nurse got here first, or
                     this is a revisit. No actions at all: a disabled Give invites somebody to
                     work out how to enable it. */
                  <AlreadyAnswered slot={slot} meId={userId} zone={zone} />
                )}
              </>
            ) : null}
          </QueryGate>
        </ScrollView>

        {slot && isOpen(slot) && !settled ? (
          <View
            style={[
              styles.bar,
              { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
            ]}
          >
            <Status result={result} inFlight={write.isPending} error={write.error} />
            <View style={styles.actions}>
              <View style={styles.action}>
                <Button
                  label="Cancel"
                  variant="secondary"
                  disabled={write.isPending}
                  onPress={() => router.back()}
                />
              </View>
              <View style={styles.action}>
                <Button
                  label={write.isPending ? "Recording…" : outcomeOption(outcome).label}
                  loading={write.isPending}
                  disabled={
                    !guard.canWrite ||
                    !canConfirm({ slot, outcome, reason, inFlight: write.isPending })
                  }
                  reason={
                    guard.reason ??
                    (outcomeOption(outcome).reasonRequired && reason.trim() === ""
                      ? "Say why the dose is being held."
                      : undefined)
                  }
                  onPress={() => {
                    setResult(undefined);
                    write.mutate({
                      status: outcome,
                      drugCode: slot.drugCode,
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    });
                  }}
                />
              </View>
            </View>
          </View>
        ) : settled ? (
          <View
            style={[
              styles.bar,
              { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
            ]}
          >
            <Button label="Done" onPress={() => router.back()} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The ordered medication, exactly as the server describes it. Nothing here is reconstructed. */
function DoseCard({
  slot,
  scheduledLabel,
}: {
  slot: DoseSlot;
  scheduledLabel: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card>
      <View style={styles.row}>
        <Text style={[typography.heading, styles.grow, { color: theme.colors.fg }]}>
          {slot.drugName}
        </Text>
        <Pill label={doseStateLabel(slot.state)} tone={doseStateTone(slot.state)} />
      </View>
      <Text style={[typography.body, { color: theme.colors.fg }]}>
        {slot.dose} · {slot.route}
      </Text>
      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
        Scheduled {scheduledLabel} · {slot.frequency}
      </Text>
    </Card>
  );
}

/**
 * The patient's allergies, shown and never interpreted.
 *
 * ── THE APP DOES NOT MATCH DRUGS AGAINST ALLERGIES, AND MUST NOT LOOK LIKE IT DOES ──
 * There is no drug-allergy engine here and this panel must not imply one. In particular an EMPTY
 * list is rendered as "none recorded" and never as "no allergies" — the difference is whether
 * anybody has asked the patient, and a nurse who reads a blank as clearance is exactly the
 * accident this wording exists to prevent. Nothing on this screen ever says a drug is safe.
 */
function AllergyContext({
  allergens,
  severe,
  allowed,
  loading,
}: {
  allergens: readonly string[];
  severe: boolean;
  allowed: boolean;
  loading: boolean;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (!allowed || loading) return null;

  return (
    <Card>
      <View style={styles.row}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Allergies</Text>
        {allergens.length > 0 ? (
          <Pill label={severe ? "Severe" : "Recorded"} tone={severe ? "critical" : "warning"} />
        ) : null}
      </View>
      <Text style={[typography.body, { color: theme.colors.fg }]}>
        {allergens.length > 0 ? allergens.join(", ") : "None recorded"}
      </Text>
      {allergens.length === 0 ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Nothing has been recorded for this patient. That is not the same as no allergies.
        </Text>
      ) : null}
    </Card>
  );
}

/** Pick the outcome, give a reason if the outcome needs one, and read back what will be recorded. */
function Compose({
  slot,
  outcome,
  onOutcome,
  reason,
  onReason,
  patientName,
  uhid,
  scheduledLabel,
}: {
  slot: DoseSlot;
  outcome: AdministerOutcome;
  onOutcome: (next: AdministerOutcome) => void;
  reason: string;
  onReason: (next: string) => void;
  patientName?: string;
  uhid?: string;
  scheduledLabel: string;
}): React.JSX.Element {
  const theme = useTheme();
  const option = outcomeOption(outcome);
  const lines = reviewLines({
    slot,
    scheduledLabel,
    outcome,
    ...(patientName ? { patientName } : {}),
    ...(uhid ? { uhid } : {}),
  });

  return (
    <>
      <SectionTitle title="What happened" />
      <View style={styles.outcomes}>
        {OUTCOMES.map((o) => (
          <OutcomeChoice
            key={o.status}
            label={o.recordAs}
            selected={o.status === outcome}
            onPress={() => onOutcome(o.status)}
          />
        ))}
      </View>

      {option.reasonPrompt ? (
        <TextField
          label={option.reasonRequired ? "Reason (required)" : "Reason"}
          value={reason}
          onChangeText={onReason}
          placeholder={option.reasonPrompt}
          multiline
          hint={
            option.reasonRequired
              ? "A held dose without a reason is the blank the medication record exists to prevent."
              : undefined
          }
        />
      ) : null}

      <SectionTitle title="Check before recording" />
      <Card>
        {lines.map((line) => (
          <View key={line.label} style={styles.reviewRow}>
            <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{line.label}</Text>
            <Text
              style={[
                line.identity ? typography.body : typography.caption,
                { color: theme.colors.fg },
              ]}
            >
              {line.value}
            </Text>
          </View>
        ))}
      </Card>

      <Text style={[typography.caption, styles.warning, { color: theme.colors.fgSubtle }]}>
        Recorded against this dose with your name and the time. The medication record cannot be
        edited afterwards.
      </Text>
    </>
  );
}

function OutcomeChoice({
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
      accessibilityLabel={`Record as ${label}`}
      onPress={onPress}
      style={[
        typography.body,
        styles.choice,
        {
          color: selected ? theme.colors.brandStrong : theme.colors.fg,
          backgroundColor: theme.colors.bgSubtle,
          // Selection is border + label colour + `accessibilityState`, never fill alone.
          borderColor: selected ? theme.colors.brandStrong : theme.colors.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      {label}
    </Text>
  );
}

/** The slot was answered before this nurse got here. Facts only, no actions. */
function AlreadyAnswered({
  slot,
  meId,
  zone,
}: {
  slot: DoseSlot;
  meId: string | undefined;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const at = parseInstant(slot.administeredAt);
  const status = slot.state as Exclude<DoseSlot["state"], "due" | "overdue">;

  return (
    <Card>
      <View style={styles.row}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Already answered</Text>
        <Pill label={marStatusLabel(status)} tone={marStatusTone(status)} />
      </View>
      <Text style={[typography.body, { color: theme.colors.fg }]}>
        Recorded as {marStatusLabel(status).toLowerCase()} {actorLabel(slot.administeredBy, meId)}
        {at ? ` at ${formatTime(at, { zone })}` : ""}.
      </Text>
      {slot.reason ? (
        <Text style={[typography.caption, { color: theme.colors.warning }]}>{slot.reason}</Text>
      ) : null}
      <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
        Do not give this dose again. If this looks wrong, speak to the nurse in charge — the record
        cannot be edited.
      </Text>
    </Card>
  );
}

/** What the server said, after the attempt. */
function Settled({
  result,
  meId,
  zone,
}: {
  result: Extract<AdministerResult, { outcome: "recorded" | "alreadyAnswered" }>;
  meId: string | undefined;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();

  if (result.outcome === "recorded") {
    const at = parseInstant(result.entry.administeredAt);
    return (
      <Card>
        <View style={styles.row} accessibilityRole="alert">
          <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Recorded</Text>
          <Pill
            label={marStatusLabel(result.entry.status)}
            tone={marStatusTone(result.entry.status)}
          />
        </View>
        <Text style={[typography.body, { color: theme.colors.fg }]}>
          {result.entry.drugName} · {result.entry.dose} · {result.entry.route}
        </Text>
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          On the chart{at ? ` at ${formatTime(at, { zone })}` : ""}.
        </Text>
      </Card>
    );
  }

  /**
   * ── THE CONCURRENT CASE, AND THE LOST-RESPONSE CASE, ARE THE SAME SCREEN ──
   * Both mean "the slot is answered and it was not by this attempt". The distinction the nurse
   * actually needs is whether it was THEM (their own request landed after all) or somebody else
   * (go and ask). That is what `isOwnAnswer` decides, and it is the only inference drawn here.
   */
  const mine = isOwnAnswer(result.existing, meId);
  const at = parseInstant(result.existing?.administeredAt);

  return (
    <Card>
      <View style={styles.row} accessibilityRole="alert">
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Already given</Text>
        <Pill
          label={result.existing ? marStatusLabel(result.existing.status) : "Answered"}
          tone={result.existing ? marStatusTone(result.existing.status) : "warning"}
        />
      </View>
      <Text style={[typography.body, { color: theme.colors.fg }]}>
        {mine
          ? `Your earlier attempt did go through — ${result.drugName} is recorded${
              at ? ` at ${formatTime(at, { zone })}` : ""
            }. Nothing was recorded twice.`
          : `${result.drugName} has already been answered ${actorLabel(
              result.existing?.administeredBy,
              meId,
            )}${at ? ` at ${formatTime(at, { zone })}` : ""}.`}
      </Text>
      {result.existing?.reason ? (
        <Text style={[typography.caption, { color: theme.colors.warning }]}>
          {result.existing.reason}
        </Text>
      ) : null}
      {!mine ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Do not give this dose again.
        </Text>
      ) : null}
      {!result.existing ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          The record is held at another site, so it cannot be shown here. The dose is answered.
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The line above the buttons.
 *
 * ── "GIVEN" IS NEVER SAID BEFORE THE SERVER SAYS IT ─────────────────────────
 * In flight it says "Recording…". Uncertain, it says the outcome is unknown and tells the nurse
 * the one safe next step: press again, which replays the same key. It never says the dose failed,
 * because the server may have committed it.
 */
function Status({
  result,
  inFlight,
  error,
}: {
  result: AdministerResult | undefined;
  inFlight: boolean;
  error: unknown;
}): React.JSX.Element | null {
  const theme = useTheme();

  if (inFlight) {
    return <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Recording…</Text>;
  }

  if (result?.outcome === "unknown") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not confirmed" tone="warning" />
        <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
          We could not confirm whether this dose was recorded, and the schedule still shows it as
          due. Press again — it cannot record the same dose twice.
        </Text>
      </View>
    );
  }

  if (result?.outcome === "failed") {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not recorded" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {toUserMessage(result.error).body}
        </Text>
      </View>
    );
  }

  // The mutation itself rejecting — `attemptAdministration` resolves rather than throwing, so this
  // is the unexpected path and is reported generically rather than interpreted.
  if (error !== null && error !== undefined) {
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not recorded" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {toUserMessage(error).body}
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[2],
  },
  grow: { flex: 1 },
  status: { gap: space[1] },
  actions: { flexDirection: "row", gap: space[2] },
  action: { flex: 1 },
  outcomes: { flexDirection: "row", flexWrap: "wrap", gap: space[2] },
  choice: {
    flexGrow: 1,
    textAlign: "center",
    minHeight: size.touchTarget,
    lineHeight: size.touchTarget,
    paddingHorizontal: space[4],
    borderRadius: 12,
    overflow: "hidden",
  },
  reviewRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[4],
    paddingVertical: space[1],
  },
  warning: { paddingHorizontal: space[1] },
});

export default requireRuntime(AdministerScreen);
