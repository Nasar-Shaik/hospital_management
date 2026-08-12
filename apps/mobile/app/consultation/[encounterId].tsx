/**
 * The consultation note (M2 G) — the first clinical WRITE on this phone.
 *
 * ── THE FORM IS THE DOCTOR'S, NOT THE SERVER'S ──────────────────────────────
 * Everything typed here lives in this screen's state and is cleared by exactly one event: a
 * confirmed 2xx. Not by an error, not by a timeout, not by going offline, not by a refetch landing
 * underneath. That single rule is what "do not silently discard entered clinical information"
 * means in code, and it is why the save mutation never resets the form and the loaded note is
 * copied in ONCE rather than mirrored.
 *
 * ── NO OFFLINE QUEUE, DELIBERATELY (M0 §11) ─────────────────────────────────
 * A queued clinical write is a note that appears on the chart at a time nobody chose, written
 * against a visit that may have closed, ordered against other queued writes by accident. So there
 * is no queue: offline, the button is disabled and says why, the words stay on screen, and the
 * doctor saves when the ward's wifi comes back. The honest failure beats the convenient lie.
 *
 * ── "SAVED" IS ONLY EVER SAID ABOUT A RESPONSE WE RECEIVED ──────────────────
 * `PUT` is naturally replay-safe — the same body twice leaves the same note, and there is no
 * second record to create — so a retry after an ambiguous failure is free and needs no
 * idempotency key. What is NOT free is claiming success we did not hear: the status line reads
 * "Not saved" until a response arrives, whatever the transport thinks happened.
 */
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, type Diagnosis } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useUnsavedChanges,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useTheme } from "../../src/hooks/useTheme";
import { formatDateTime } from "../../src/lib/time";
import { toUserMessage } from "../../src/lib/net/errors";
import {
  EMPTY_FORM,
  formFrom,
  isDirty,
  patchFor,
  withDiagnosis,
  withDiagnosisType,
  withoutDiagnosis,
  type ConsultationForm,
} from "../../src/clinical/consultation";
import { space, typography } from "../../src/theme/tokens";

function Consultation(): React.JSX.Element {
  const theme = useTheme();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready } = useClinical();
  const zoneFor = useZoneFor();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("emr:write");

  const note = useQuery({ ...queries.consultation(encounterId), enabled: ready });

  /**
   * `loaded` is the note AS IT WAS WHEN THIS SCREEN TOOK IT. It is the baseline for "what did I
   * change", and it moves only when a save succeeds — so a background refetch cannot silently
   * redefine what counts as the doctor's own edit.
   */
  const [loaded, setLoaded] = useState<ConsultationForm>(EMPTY_FORM);
  const [form, setForm] = useState<ConsultationForm>(EMPTY_FORM);
  const [seeded, setSeeded] = useState(false);
  const [diagnosisText, setDiagnosisText] = useState("");
  const [savedAt, setSavedAt] = useState<Date | undefined>(undefined);

  /**
   * Seeded ONCE. A `useEffect` that copied `note.data` into the form whenever it changed would
   * overwrite whatever the doctor was typing the moment a refetch landed — the classic controlled
   * form bug, and here it deletes clinical text mid-sentence.
   */
  useEffect(() => {
    if (seeded || note.isPending || !ready) return;
    const initial = formFrom(note.data);
    setLoaded(initial);
    setForm(initial);
    setSeeded(true);
  }, [seeded, note.isPending, note.data, ready]);

  const save = useClinicalWrite(mutations.saveConsultation(encounterId), {
    onSuccess: (saved) => {
      // The ONE place the baseline moves, and the one place "Saved" becomes true. Re-seeded from
      // the SERVER's answer, not from the form: the server trims and normalises, and the next
      // dirty check has to compare against what is actually stored.
      const persisted = formFrom(saved);
      setLoaded(persisted);
      setForm(persisted);
      setSavedAt(new Date());
    },
  });

  const dirty = isDirty(loaded, form);
  useUnsavedChanges(dirty, "consultation note");

  const patch = patchFor(loaded, form);
  const canSave = guard.canWrite && patch !== undefined && !save.isPending;

  /** Field errors from a `HMS-VAL-001`, mapped onto the inputs by name. */
  const fieldErrors =
    save.error instanceof ApiClientError
      ? save.error.fieldErrors
      : ({} as Record<string, string[]>);

  const set = (field: keyof ConsultationForm, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <QueryGate
            loading={note.isPending && ready}
            error={note.error}
            emptyTitle="Consultation unavailable"
            loadingLabel="Loading the note…"
            onRetry={() => void note.refetch()}
          >
            <TextField
              label="Presenting complaint"
              value={form.chiefComplaint}
              onChangeText={(v) => set("chiefComplaint", v)}
              placeholder="What brought them in"
              multiline
              errors={fieldErrors.chiefComplaint}
            />
            <TextField
              label="History"
              value={form.history}
              onChangeText={(v) => set("history", v)}
              multiline
              errors={fieldErrors.history}
            />
            <TextField
              label="Examination"
              value={form.examination}
              onChangeText={(v) => set("examination", v)}
              multiline
              errors={fieldErrors.examination}
            />

            <SectionTitle title="Diagnoses" trailing={String(form.diagnoses.length)} />
            <Card>
              {form.diagnoses.map((diagnosis, index) => (
                <DiagnosisRow
                  key={`${diagnosis.text}-${String(index)}`}
                  diagnosis={diagnosis}
                  onToggleType={() =>
                    setForm((c) =>
                      withDiagnosisType(
                        c,
                        index,
                        diagnosis.type === "provisional" ? "final" : "provisional",
                      ),
                    )
                  }
                  onRemove={() => setForm((c) => withoutDiagnosis(c, index))}
                />
              ))}
              <TextField
                label="Add a diagnosis"
                value={diagnosisText}
                onChangeText={setDiagnosisText}
                placeholder="e.g. Acute bronchitis"
                returnKeyType="done"
                onSubmitEditing={() => {
                  setForm((c) => withDiagnosis(c, diagnosisText));
                  setDiagnosisText("");
                }}
                errors={fieldErrors.diagnoses}
              />
              <Button
                label="Add"
                variant="secondary"
                disabled={diagnosisText.trim().length === 0}
                onPress={() => {
                  setForm((c) => withDiagnosis(c, diagnosisText));
                  setDiagnosisText("");
                }}
              />
            </Card>

            <TextField
              label="Plan"
              value={form.plan}
              onChangeText={(v) => set("plan", v)}
              multiline
              errors={fieldErrors.plan}
            />
            <TextField
              label="Follow-up in (days)"
              value={form.followUpDays}
              onChangeText={(v) => set("followUpDays", v.replace(/[^0-9]/g, ""))}
              keyboardType="number-pad"
              hint="Leave blank if no follow-up is needed."
              errors={fieldErrors.followUpDays}
            />
          </QueryGate>
        </ScrollView>

        {/* Pinned, so the state of the save and the way to retry it are never scrolled away. */}
        <View
          style={[
            styles.bar,
            { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
          ]}
        >
          <SaveStatus
            dirty={dirty}
            saving={save.isPending}
            error={save.error}
            savedAt={savedAt}
            zone={zoneFor(undefined)}
          />
          <Button
            label={save.isPending ? "Saving…" : "Save note"}
            loading={save.isPending}
            disabled={!canSave}
            reason={guard.reason ?? (patch === undefined ? "Nothing has changed yet." : undefined)}
            onPress={() => {
              if (patch) save.mutate(patch);
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * Saving / Saved / Not saved — and never the wrong one.
 *
 * The error case wins over everything, including a `savedAt` from earlier in the session: a doctor
 * who saved successfully at 09:10, edited, and failed to save at 09:14 must not see "Saved 09:10"
 * under their unsaved words. That is the exact reading that gets a note lost.
 */
function SaveStatus({
  dirty,
  saving,
  error,
  savedAt,
  zone,
}: {
  dirty: boolean;
  saving: boolean;
  error: unknown;
  savedAt?: Date;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();

  if (saving) {
    return <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Saving…</Text>;
  }

  if (error !== null && error !== undefined) {
    const message = toUserMessage(error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {message.body} Your note is still here — try again when you can.
        </Text>
      </View>
    );
  }

  if (dirty) {
    return (
      <View style={styles.status}>
        <Pill label="Unsaved changes" tone="warning" />
      </View>
    );
  }

  if (savedAt) {
    return (
      <Text style={[typography.caption, { color: theme.colors.success }]}>
        Saved {formatDateTime(savedAt, zone)}
      </Text>
    );
  }

  return <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>No changes.</Text>;
}

function DiagnosisRow({
  diagnosis,
  onToggleType,
  onRemove,
}: {
  diagnosis: Diagnosis;
  onToggleType: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.diagnosis}>
      <Text style={[typography.body, styles.fill, { color: theme.colors.fg }]}>
        {diagnosis.text}
      </Text>
      <Text
        accessibilityRole="button"
        accessibilityLabel={`Mark as ${diagnosis.type === "provisional" ? "final" : "provisional"}`}
        onPress={onToggleType}
        style={[typography.caption, { color: theme.colors.brandStrong }]}
      >
        {diagnosis.type}
      </Text>
      <Text
        accessibilityRole="button"
        accessibilityLabel={`Remove ${diagnosis.text}`}
        onPress={onRemove}
        style={[typography.caption, { color: theme.colors.danger }]}
      >
        Remove
      </Text>
    </View>
  );
}

export default requireRuntime(Consultation);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  bar: { borderTopWidth: 1, padding: space[4], gap: space[2] },
  status: { gap: space[1] },
  diagnosis: { flexDirection: "row", alignItems: "center", gap: space[3] },
});
