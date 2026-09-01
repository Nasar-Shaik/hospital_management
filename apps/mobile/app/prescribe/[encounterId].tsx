/**
 * Prescribing (M2 I) — compose, screen, review, sign.
 *
 * ── FOUR STAGES, AND SIGNING IS ONLY REACHABLE FROM ONE ─────────────────────
 * `composing → screening → review → signing → signed`. The signature is a button on the REVIEW
 * stage and exists nowhere else: not in a list row, not in an effect, not as a consequence of
 * navigating. That is the whole guard against an accidental signature, and it is structural rather
 * than a confirmation dialog somebody can learn to dismiss.
 *
 * Editing a line while a review is open throws the review away (`screeningStillValid`). The alerts
 * on screen were a statement about specific drugs at specific doses; the moment one moves they
 * describe something the doctor is no longer signing, and a stale green "no alerts" in front of a
 * prescriber is the kind of reassurance that stops them looking.
 *
 * ── THE SIGNATURE IS THE ONLY IRREVERSIBLE ACT IN THIS SLICE ────────────────
 * After it the prescription is immutable, the pharmacy has it, and changing a dose means a new
 * version. So the review lists every line in full — drug, dose, route, frequency, duration,
 * quantity, instructions — beside the patient's name and their allergies, and the button says
 * "Sign" rather than "Save".
 *
 * ── AND ITS FAILURES ARE HANDLED BY `clinical/signing.ts`, NOT HERE ──────────
 * `attemptSign` classifies every ending into signed / blocked / unsigned / failed, reconciling
 * against the record whenever the answer was ambiguous. This screen switches on that outcome. It
 * contains no `catch` around a signature and no retry loop: the retry is the doctor pressing the
 * button again, which the state machine makes safe.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { PrescriptionLineInput, SafetyAlert } from "@medicore/api-client";
import { DRUG_FREQUENCIES, DRUG_ROUTES } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { AllergyBanner, PatientName } from "../../src/components/clinical/Identity";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useUnsavedChanges,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useCapabilities } from "../../src/hooks/useStores";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDateTime, parseInstant } from "../../src/lib/time";
import { toUserMessage } from "../../src/lib/net/errors";
import {
  describeLine,
  newLine,
  removeLine,
  screeningStillValid,
  updateLine,
} from "../../src/clinical/prescribing";
import { isSigned } from "../../src/clinical/signing";
import { radius, size, space, typography } from "../../src/theme/tokens";

type Stage =
  | { stage: "composing" }
  /** A draft exists on the server and has been screened. Signing is reachable ONLY from here. */
  | {
      stage: "review";
      draftId: string;
      alerts: SafetyAlert[];
      blocking: boolean;
      lines: PrescriptionLineInput[];
    }
  | { stage: "signed"; prescriptionId: string; signedAt?: string; reconciled: boolean };

function Prescribe(): React.JSX.Element {
  const theme = useTheme();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();
  const mutations = useClinicalMutations();
  const { can } = useCapabilities();
  const composeGuard = useWriteGuard("prescription:create");
  const signGuard = useWriteGuard("prescription:sign");

  const [lines, setLines] = useState<PrescriptionLineInput[]>([]);
  const [stage, setStage] = useState<Stage>({ stage: "composing" });
  const [override, setOverride] = useState("");
  const [filter, setFilter] = useState("");
  const [signError, setSignError] = useState<unknown>(undefined);

  const encounter = useQuery({ ...queries.encounter(encounterId), enabled: ready });
  const patientId = encounter.data?.patientId;

  const catalogue = useQuery({ ...queries.catalogue("pharmacy"), enabled: ready });
  const allergies = useQuery({
    ...queries.allergies(patientId ?? ""),
    enabled: ready && Boolean(patientId) && can("allergy:read"),
  });
  const history = useQuery({
    ...queries.prescriptions(patientId ?? ""),
    enabled: ready && Boolean(patientId),
  });

  const create = useClinicalWrite(mutations.createPrescription(encounterId));
  const screen = useClinicalWrite(mutations.screen());
  const sign = useClinicalWrite(mutations.sign(stage.stage === "review" ? stage.draftId : ""));
  const discard = useClinicalWrite(mutations.discard());

  // Unsaved work here is a composed-but-unsigned prescription — which binds nobody, but which the
  // doctor would have to type again.
  useUnsavedChanges(lines.length > 0 && stage.stage !== "signed", "prescription");

  const drugs = (catalogue.data ?? []).filter((item) => {
    const q = filter.trim().toLowerCase();
    return q.length === 0 || item.name.toLowerCase().includes(q);
  });

  /** Editing invalidates a pending review — see the header. */
  const edit = (next: PrescriptionLineInput[]): void => {
    setLines(next);
    setSignError(undefined);
    if (stage.stage === "review" && !screeningStillValid(stage.lines, next)) {
      // The draft on the server was screened against the old lines; it is no longer the thing
      // being signed, so it is thrown away rather than left as an unsigned orphan.
      discard.mutate(stage.draftId);
      setStage({ stage: "composing" });
      setOverride("");
    }
  };

  /** Compose → draft → screen. Creates a record, signs nothing. */
  const reviewNow = (): void => {
    setSignError(undefined);
    create.mutate(lines, {
      onSuccess: (draft) => {
        screen.mutate(draft.id, {
          onSuccess: (screening) => {
            setStage({
              stage: "review",
              draftId: draft.id,
              alerts: screening.alerts,
              blocking: screening.blocking,
              lines: [...lines],
            });
          },
        });
      },
    });
  };

  /** The signature. One attempt, reconciled — never a loop. */
  const signNow = (): void => {
    if (stage.stage !== "review") return;
    setSignError(undefined);
    sign.mutate(
      { ...(stage.blocking && override.trim() ? { overrideReason: override.trim() } : {}) },
      {
        onSuccess: (outcome) => {
          if (outcome.outcome === "signed") {
            setStage({
              stage: "signed",
              prescriptionId: outcome.prescription.id,
              ...(outcome.prescription.signedAt ? { signedAt: outcome.prescription.signedAt } : {}),
              reconciled: outcome.reconciled,
            });
            setLines([]);
            setOverride("");
            return;
          }
          if (outcome.outcome === "blocked") {
            // The server re-screened at the signature and found a contraindication the pad had not
            // shown. Back to review with the real alerts, and an override reason now required.
            setStage({ ...stage, alerts: outcome.alerts, blocking: true });
            return;
          }
          // `unsigned` and `failed` both stay on review with the prescription intact. The
          // difference is only in what the message says about trying again.
          setSignError(outcome.error);
        },
      },
    );
  };

  const busy = create.isPending || screen.isPending || sign.isPending;

  if (stage.stage === "signed") {
    return <SignedConfirmation stage={stage} zone={zoneFor(encounter.data?.branchId)} />;
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {patientId ? (
          <Card>
            <PatientName patientId={patientId} />
            <AllergyBanner allergies={allergies.data} loading={allergies.isPending && ready} />
          </Card>
        ) : null}

        {stage.stage === "review" ? (
          <ReviewPanel
            alerts={stage.alerts}
            blocking={stage.blocking}
            override={override}
            onOverride={setOverride}
            error={signError}
          />
        ) : null}

        <SectionTitle title="Prescription" trailing={String(lines.length)} />
        {lines.length === 0 ? (
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            Nothing yet. Choose a drug below.
          </Text>
        ) : (
          lines.map((line, index) => (
            <LineEditor
              key={`${line.drugCode}-${String(index)}`}
              line={line}
              locked={stage.stage === "review"}
              onChange={(patch) => edit(updateLine(lines, index, patch))}
              onRemove={() => edit(removeLine(lines, index))}
            />
          ))
        )}

        <SectionTitle title="Add a drug" />
        <TextField
          label="Search"
          value={filter}
          onChangeText={setFilter}
          placeholder="Amoxicillin…"
        />
        <QueryGate
          loading={catalogue.isPending && ready}
          error={catalogue.error}
          empty={drugs.length === 0}
          emptyTitle="No drugs match"
          loadingLabel="Loading the formulary…"
          onRetry={() => void catalogue.refetch()}
        >
          <View style={styles.chips}>
            {drugs.slice(0, 40).map((drug) => (
              <Text
                key={drug.code}
                accessibilityRole="button"
                onPress={() => edit([...lines, newLine(drug)])}
                style={[
                  styles.chip,
                  {
                    color: theme.colors.fg,
                    backgroundColor: theme.colors.bgSubtle,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                + {drug.name}
              </Text>
            ))}
          </View>
        </QueryGate>

        {(history.data?.length ?? 0) > 0 ? (
          <View style={styles.group}>
            <SectionTitle title="In force" trailing={String(history.data?.length ?? 0)} />
            {(history.data ?? []).map((rx) => {
              const at = parseInstant(rx.signedAt ?? rx.prescribedAt);
              return (
                <Card key={rx.id}>
                  <View style={styles.rowTop}>
                    <Pill
                      label={isSigned(rx) ? rx.status.replace(/_/g, " ") : "draft"}
                      tone={isSigned(rx) ? "done" : "neutral"}
                    />
                    {rx.version > 1 ? (
                      <Pill label={`v${String(rx.version)}`} tone="neutral" />
                    ) : null}
                  </View>
                  {rx.lines.map((line, i) => (
                    <Text
                      key={`${line.drugCode}-${String(i)}`}
                      style={[typography.caption, { color: theme.colors.fg }]}
                    >
                      {line.drugName} — {line.dose} {line.route} {line.frequency} (
                      {line.dispensedQty}/{line.quantity} given)
                    </Text>
                  ))}
                  {at ? (
                    <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
                      {formatDateTime(at, zoneFor(rx.branchId))}
                    </Text>
                  ) : null}
                </Card>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <View
        style={[
          styles.bar,
          { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
        ]}
      >
        {stage.stage === "composing" ? (
          <>
            <Button
              label={
                busy
                  ? "Checking…"
                  : `Review ${String(lines.length)} drug${lines.length === 1 ? "" : "s"}`
              }
              loading={busy}
              disabled={!composeGuard.canWrite || lines.length === 0 || busy}
              reason={composeGuard.reason}
              onPress={reviewNow}
            />
            <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
              Reviewing checks the patient&apos;s allergies. Nothing is prescribed until you sign.
            </Text>
            {create.error !== null && create.error !== undefined ? (
              <Text style={[typography.caption, { color: theme.colors.danger }]}>
                {toUserMessage(create.error).body}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Button
              label={
                sign.isPending
                  ? "Signing…"
                  : stage.blocking
                    ? "Override and sign"
                    : "Sign prescription"
              }
              variant={stage.blocking ? "danger" : "primary"}
              loading={sign.isPending}
              disabled={
                !signGuard.canWrite || busy || (stage.blocking && override.trim().length === 0)
              }
              reason={
                signGuard.reason ??
                (stage.blocking && override.trim().length === 0
                  ? "A contraindication must be acknowledged with a reason before signing."
                  : undefined)
              }
              onPress={signNow}
            />
            <Button
              label="Go back and edit"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                discard.mutate(stage.draftId);
                setStage({ stage: "composing" });
                setOverride("");
                setSignError(undefined);
              }}
            />
            <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
              After signing this cannot be edited — changing a dose creates a new version.
            </Text>
          </>
        )}
      </View>
    </Screen>
  );
}

/** What the doctor sees after the signature landed — including when we learned it by re-reading. */
function SignedConfirmation({
  stage,
  zone,
}: {
  stage: { prescriptionId: string; signedAt?: string; reconciled: boolean };
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const at = parseInstant(stage.signedAt);
  return (
    <Screen>
      <View style={styles.signed} accessibilityRole="alert">
        <Pill label="Signed" tone="done" />
        <Text style={[typography.title, { color: theme.colors.fg }]}>Prescription signed</Text>
        <Text style={[typography.body, { color: theme.colors.fgMuted }]}>
          The pharmacy has it. Changing a dose from here on creates a new version.
        </Text>
        {at ? (
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            {formatDateTime(at, zone)}
          </Text>
        ) : null}
        {stage.reconciled ? (
          /**
           * The honest sentence for the case this whole flow exists for: the signature landed, the
           * reply did not, and we found out by re-reading the record. Saying so beats both of the
           * alternatives — a silent success the doctor half-remembers failing, and an error about
           * something that worked.
           */
          <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
            The connection dropped before the confirmation arrived, so this was checked against the
            record. It was signed successfully — nothing was prescribed twice.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

function ReviewPanel({
  alerts,
  blocking,
  override,
  onOverride,
  error,
}: {
  alerts: SafetyAlert[];
  blocking: boolean;
  override: string;
  onOverride: (value: string) => void;
  error: unknown;
}): React.JSX.Element {
  const theme = useTheme();
  const message = error === null || error === undefined ? undefined : toUserMessage(error);

  return (
    <Card
      style={{
        borderColor: blocking ? theme.colors.danger : theme.colors.borderStrong,
        borderWidth: blocking ? 2 : 1,
      }}
    >
      <Text style={[typography.heading, { color: theme.colors.fg }]}>
        {blocking ? "Safety alert — review before signing" : "Review before signing"}
      </Text>

      {alerts.length === 0 ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          No allergy, interaction or duplicate-therapy alerts.
        </Text>
      ) : (
        alerts.map((alert, index) => (
          <View
            key={`${alert.kind}-${String(index)}`}
            accessibilityRole="alert"
            style={[
              styles.alert,
              {
                backgroundColor:
                  alert.severity === "contraindicated"
                    ? theme.colors.dangerBg
                    : theme.colors.warningBg,
              },
            ]}
          >
            <Text
              style={[
                typography.label,
                {
                  color:
                    alert.severity === "contraindicated"
                      ? theme.colors.danger
                      : theme.colors.warning,
                },
              ]}
            >
              {alert.severity === "contraindicated"
                ? "CONTRAINDICATED"
                : alert.kind.replace(/_/g, " ").toUpperCase()}
            </Text>
            <Text style={[typography.body, { color: theme.colors.fg }]}>{alert.message}</Text>
          </View>
        ))
      )}

      {blocking ? (
        <TextField
          label="Reason for overriding (recorded on the prescription)"
          value={override}
          onChangeText={onOverride}
          multiline
          placeholder="e.g. prior reaction was a mild childhood rash; benefit outweighs risk, will monitor"
        />
      ) : null}

      {message ? (
        <View accessibilityRole="alert" style={styles.signFailure}>
          <Pill label="Not signed" tone="critical" />
          <Text style={[typography.caption, { color: theme.colors.danger }]}>
            {message.body} The prescription was checked against the record and is still unsigned —
            pressing Sign again is safe.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function LineEditor({
  line,
  locked,
  onChange,
  onRemove,
}: {
  line: PrescriptionLineInput;
  /** During review the lines are what was screened. Editing returns to composing — see `edit`. */
  locked: boolean;
  onChange: (patch: Partial<PrescriptionLineInput>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const theme = useTheme();

  if (locked) {
    return (
      <Card>
        <Text style={[typography.heading, { color: theme.colors.fg }]}>{line.drugName}</Text>
        <Text style={[typography.body, { color: theme.colors.fgMuted }]}>{describeLine(line)}</Text>
        {line.instructions ? (
          <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
            {line.instructions}
          </Text>
        ) : null}
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.rowTop}>
        <Text style={[typography.heading, styles.grow, { color: theme.colors.fg }]}>
          {line.drugName}
        </Text>
        <Text
          accessibilityRole="button"
          accessibilityLabel={`Remove ${line.drugName}`}
          onPress={onRemove}
          style={[typography.caption, { color: theme.colors.danger }]}
        >
          Remove
        </Text>
      </View>

      <TextField label="Dose" value={line.dose} onChangeText={(dose) => onChange({ dose })} />

      <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Route</Text>
      <View style={styles.chips}>
        {DRUG_ROUTES.map((route) => (
          <Option
            key={route}
            label={route}
            selected={line.route === route}
            onPress={() => onChange({ route })}
          />
        ))}
      </View>

      <Text style={[typography.label, { color: theme.colors.fgMuted }]}>Frequency</Text>
      <View style={styles.chips}>
        {DRUG_FREQUENCIES.map((frequency) => (
          <Option
            key={frequency}
            label={frequency}
            selected={line.frequency === frequency}
            onPress={() => onChange({ frequency })}
          />
        ))}
      </View>

      <View style={styles.pair}>
        <View style={styles.grow}>
          <TextField
            label="Days"
            value={String(line.durationDays ?? "")}
            keyboardType="number-pad"
            onChangeText={(v) => onChange({ durationDays: Number(v.replace(/[^0-9]/g, "")) || 0 })}
          />
        </View>
        <View style={styles.grow}>
          <TextField
            label="Quantity"
            value={String(line.quantity)}
            keyboardType="number-pad"
            onChangeText={(v) => onChange({ quantity: Number(v.replace(/[^0-9]/g, "")) || 0 })}
          />
        </View>
      </View>

      <TextField
        label="Instructions (optional)"
        value={line.instructions ?? ""}
        onChangeText={(instructions) => onChange({ instructions })}
        placeholder="after food"
      />
    </Card>
  );
}

function Option({
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

export default requireRuntime(Prescribe);

const styles = StyleSheet.create({
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  group: { gap: space[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[1] },
  chip: {
    ...typography.label,
    borderWidth: 1,
    borderRadius: radius.md,
    minHeight: size.touchTarget - 16,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    overflow: "hidden",
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: space[2] },
  grow: { flex: 1 },
  pair: { flexDirection: "row", gap: space[3] },
  bar: { borderTopWidth: 1, padding: space[4], gap: space[2] },
  alert: { borderRadius: radius.md, padding: space[3], gap: space[1] },
  signFailure: { gap: space[1] },
  signed: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space[3],
    padding: space[6],
  },
});
