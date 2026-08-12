/**
 * Today's entry on the round (M2 J) — the ward's own write.
 *
 * ── A WARD NOTE IS APPEND-ONLY AND PERMANENT ────────────────────────────────
 * There is no update path and no delete path in the repository, and that is the design: a
 * contemporaneous record that can be rewritten afterwards is not evidence of anything. A correction
 * is a NEW note that says so. So this screen writes; it never edits, and it says as much before the
 * doctor commits, because "save" reads as reversible everywhere else in software.
 *
 * ── THE RETRY HAZARD IS REAL AND IT IS HANDLED IN `clinical/wardNote.ts` ────
 * The endpoint has no idempotency key and the repository has no de-duplication, so a naive retry
 * after a lost response leaves TWO identical notes on the chart, permanently. Every ambiguous
 * ending therefore goes through `attemptWardNote`, which re-reads the notes and looks for one that
 * was not there before. The doctor is told which of the two things happened, in words.
 *
 * ── NO OFFLINE QUEUE (M0 §11) ───────────────────────────────────────────────
 * Offline the button is disabled with a reason, the text stays on screen, and nothing is promised.
 * A queued ward note would land at a time nobody chose, possibly after the patient was discharged.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, type WardNote } from "@medicore/api-client";
import { Screen } from "../../src/components/Screen";
import { Card, SectionTitle } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { TextField } from "../../src/components/TextField";
import { Pill } from "../../src/components/Pill";
import { QueryGate } from "../../src/components/QueryGate";
import { WardNoteRow } from "../../src/components/clinical/Stay";
import { requireRuntime } from "../../src/providers/RuntimeProvider";
import { useClinical, useZoneFor } from "../../src/hooks/useClinical";
import {
  useClinicalMutations,
  useClinicalWrite,
  useUnsavedChanges,
  useWriteGuard,
} from "../../src/hooks/useWrite";
import { useTheme } from "../../src/hooks/useTheme";
import { toUserMessage } from "../../src/lib/net/errors";
import type { WardNoteOutcome } from "../../src/clinical/wardNote";
import { space, typography } from "../../src/theme/tokens";

function WardNoteScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { encounterId } = useLocalSearchParams<{ encounterId: string }>();
  const { queries, ready, userId } = useClinical();
  const zoneFor = useZoneFor();
  const mutations = useClinicalMutations();
  const guard = useWriteGuard("emr:write");

  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<WardNoteOutcome | undefined>(undefined);

  const notes = useQuery({ ...queries.wardNotes(encounterId), enabled: ready });

  /**
   * ── THE SNAPSHOT IS THE WHOLE RECONCILIATION ────────────────────────────────
   * `before` is the notes as this screen has them RIGHT NOW, immediately before the attempt. After
   * an ambiguous failure the reconciler re-reads and looks for a note that is not in this set — a
   * set difference on ids, so it needs no clock and cannot mistake yesterday's identical
   * "Reviewed. Stable." for today's.
   *
   * `undefined` — the list never loaded, or failed — deliberately DISABLES the "saved" conclusion.
   * Wrongly reporting a save loses a clinical note; wrongly reporting a failure costs a duplicate.
   * Only one of those is recoverable, so the uncertain case takes the recoverable side.
   */
  const before: readonly WardNote[] | undefined = notes.isSuccess ? notes.data : undefined;

  const write = useClinicalWrite(
    mutations.addWardNote(encounterId, { before, ...(userId ? { authorId: userId } : {}) }),
    {
      onSuccess: (result) => {
        setOutcome(result);
        // Cleared on a landed note ONLY. Every other outcome leaves the words on screen.
        if (result.outcome === "saved") setText("");
      },
    },
  );

  const written = text.trim();
  const dirty = written.length > 0;
  useUnsavedChanges(dirty, "ward note");

  const canSave = guard.canWrite && dirty && !write.isPending;
  const fieldErrors =
    write.error instanceof ApiClientError
      ? write.error.fieldErrors
      : ({} as Record<string, string[]>);

  const zone = zoneFor(undefined);
  const existing = [...(notes.data ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <TextField
            label="Progress note"
            value={text}
            onChangeText={setText}
            placeholder="How the patient is, what changed, what is planned"
            multiline
            hint="Saved to the chart as written, with your name and the time. It cannot be edited afterwards — a correction is a new note."
            errors={fieldErrors.text}
          />

          <SectionTitle title="Earlier on this stay" trailing={String(existing.length)} />
          <QueryGate
            loading={notes.isPending && ready}
            error={notes.error}
            empty={existing.length === 0}
            emptyTitle="Nothing written yet"
            emptyBody="This will be the first entry on the stay."
            onRetry={() => void notes.refetch()}
          >
            <Card>
              {existing.map((note) => (
                <WardNoteRow key={note.id} note={note} zone={zone} />
              ))}
            </Card>
          </QueryGate>
        </ScrollView>

        <View
          style={[
            styles.bar,
            { borderTopColor: theme.colors.border, backgroundColor: theme.colors.bgElevated },
          ]}
        >
          <WriteStatus
            outcome={outcome}
            saving={write.isPending}
            error={write.error}
            dirty={dirty}
            onDone={() => router.back()}
          />
          <Button
            label={write.isPending ? "Saving…" : "Add to the chart"}
            loading={write.isPending}
            disabled={!canSave}
            reason={guard.reason ?? (dirty ? undefined : "Write the note first.")}
            onPress={() => {
              setOutcome(undefined);
              write.mutate(written);
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * What happened, said plainly — and never "saved" about something we did not confirm.
 *
 * The reconciled case gets its own sentence rather than a bare tick. A doctor whose phone just
 * showed a spinner and then a failure needs to be told, explicitly, that the app went and checked
 * the chart and the note is on it — otherwise they write it again, which is the exact duplicate the
 * reconciliation exists to prevent.
 */
function WriteStatus({
  outcome,
  saving,
  error,
  dirty,
  onDone,
}: {
  outcome: WardNoteOutcome | undefined;
  saving: boolean;
  error: unknown;
  dirty: boolean;
  onDone: () => void;
}): React.JSX.Element | null {
  const theme = useTheme();

  if (saving) {
    return <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>Saving…</Text>;
  }

  // The mutation itself rejecting — the reconciliation resolves rather than throwing, so this is
  // the unexpected path and it is reported generically rather than interpreted.
  if (error !== null && error !== undefined && !outcome) {
    const message = toUserMessage(error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {message.body} Your note is still here.
        </Text>
      </View>
    );
  }

  if (outcome?.outcome === "saved") {
    return (
      <View style={styles.status}>
        <Pill label="On the chart" tone="done" />
        <Text style={[typography.caption, { color: theme.colors.success }]}>
          {outcome.reconciled
            ? "The connection dropped before the confirmation arrived, so this was checked against the chart. The note is there — nothing was written twice."
            : "Added to the stay's record."}
        </Text>
        <Button label="Back to the chart" variant="secondary" onPress={onDone} />
      </View>
    );
  }

  if (outcome?.outcome === "notSaved") {
    const message = toUserMessage(outcome.error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>
          {message.body} The chart was checked and this note is not on it — your words are still
          here, so try again.
        </Text>
      </View>
    );
  }

  if (outcome?.outcome === "failed") {
    const message = toUserMessage(outcome.error);
    return (
      <View accessibilityRole="alert" style={styles.status}>
        <Pill label="Not saved" tone="critical" />
        <Text style={[typography.caption, { color: theme.colors.danger }]}>{message.body}</Text>
      </View>
    );
  }

  if (dirty) {
    return (
      <View style={styles.status}>
        <Pill label="Not added yet" tone="warning" />
      </View>
    );
  }

  return null;
}

export default requireRuntime(WardNoteScreen);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { gap: space[3], padding: space[4], paddingBottom: space[8] },
  bar: { borderTopWidth: 1, padding: space[4], gap: space[2] },
  status: { gap: space[1] },
});
