/**
 * The inpatient pieces of the chart: where they are, what has been written, what has been given.
 *
 * ── THESE ARE ADDITIONS TO THE CHART, NOT A SECOND CHART ────────────────────
 * Identity, allergies, vitals, results and the timeline are the SAME components an outpatient gets,
 * on the same screen, reading the same episode. What an admission adds is a location, a length of
 * stay, a running note and a medication record — and that is all this file is. A doctor moving
 * between an OPD patient and a ward patient should feel they changed context, not application.
 */
import { StyleSheet, Text, View } from "react-native";
import type { Encounter, MedicationAdministration, WardNote } from "@medicore/api-client";
import { Card } from "../Card";
import { Pill } from "../Pill";
import { useTheme } from "../../hooks/useTheme";
import { formatDateTime, formatRelativeDay, formatTime, parseInstant } from "../../lib/time";
import { space, typography } from "../../theme/tokens";
import {
  dayOfStay,
  dispositionLabel,
  isStayOpen,
  marStatusLabel,
  marStatusTone,
  placementLabel,
  wardKindLabel,
  type Placement,
} from "../../clinical/ipd";

/**
 * Where the patient is and how long they have been there — the header of every ward interaction.
 *
 * ── THE BED IS THE MOST OPERATIONALLY IMPORTANT LINE ON THE SCREEN ──────────
 * It is how a doctor finds the patient, and it is what they check against the name above it before
 * touching anything. So it is rendered at body weight rather than as a caption, and it says "Bed
 * not recorded" in words when there is nothing to show — a blank line where the bed belongs is how
 * somebody ends up at the wrong bay.
 */
export function StayCard({
  encounter,
  placement,
  zone,
  now = new Date(),
}: {
  encounter: Encounter;
  placement?: Placement;
  zone: string;
  now?: Date;
}): React.JSX.Element {
  const theme = useTheme();
  const admitted = parseInstant(encounter.admittedAt);
  const discharged = parseInstant(encounter.dischargedAt);
  const open = isStayOpen(encounter);
  const kind = wardKindLabel(placement?.wardKind);
  const disposition = dispositionLabel(encounter.disposition);

  return (
    <Card>
      <View style={styles.row}>
        <Text style={[typography.label, { color: theme.colors.fgMuted }]}>
          {open ? "Admitted" : "Stay ended"}
          {kind ? ` · ${kind}` : ""}
        </Text>
        {open && admitted ? (
          <Pill label={`Day ${String(dayOfStay(admitted, now, zone))}`} tone="active" />
        ) : disposition ? (
          <Pill
            label={disposition}
            tone={encounter.disposition === "deceased" ? "warning" : "done"}
          />
        ) : null}
      </View>

      <Text style={[typography.body, { color: theme.colors.fg }]}>{placementLabel(placement)}</Text>

      {/* A stay in a bed the inventory does not carry. Shown, not hidden — the ward can only fix
          what it can see, and the patient is genuinely there either way. */}
      {placement && !placement.inInventory ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          This bed is not in the bed inventory.
        </Text>
      ) : null}

      {admitted ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Admitted {formatDateTime(admitted, zone)}
        </Text>
      ) : null}
      {discharged ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
          Discharged {formatDateTime(discharged, zone)}
        </Text>
      ) : null}
    </Card>
  );
}

const NOTE_TYPES: Record<
  WardNote["type"],
  { label: string; tone: "neutral" | "done" | "warning" }
> = {
  progress: { label: "Progress note", tone: "neutral" },
  discharge_summary: { label: "Discharge summary", tone: "done" },
  outcome_note: { label: "Outcome", tone: "warning" },
};

/**
 * One entry on the stay's record.
 *
 * The type is always shown as a WORD. A discharge summary and a Tuesday progress note are the same
 * shape of object and read completely differently, and the difference between them is the whole
 * question a doctor opening the chart is asking.
 */
export function WardNoteRow({ note, zone }: { note: WardNote; zone: string }): React.JSX.Element {
  const theme = useTheme();
  const at = parseInstant(note.at);
  const kind = NOTE_TYPES[note.type];

  return (
    <View style={[styles.entry, { borderTopColor: theme.colors.border }]}>
      <View style={styles.row}>
        <Pill label={kind.label} tone={kind.tone} />
        {at ? (
          <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
            {formatRelativeDay(at, zone)} · {formatTime(at, { zone })}
          </Text>
        ) : null}
      </View>

      <Text style={[typography.body, { color: theme.colors.fg }]}>{note.text}</Text>

      {note.diagnosis ? <Labelled label="Diagnosis" value={note.diagnosis} /> : null}
      {note.advice ? <Labelled label="Advice" value={note.advice} /> : null}
      {note.followUpOn ? <Labelled label="Follow-up" value={note.followUpOn} /> : null}
    </View>
  );
}

/**
 * One charted dose.
 *
 * ── THE STATUS IS THE POINT, NOT THE DRUG ───────────────────────────────────
 * A signed prescription already says what the patient should be on. The only thing the MAR adds is
 * whether it happened — so `Given` / `Held` / `Refused` leads, and a dose that did NOT go in is
 * toned to be noticed. `reason` is rendered whenever the nurse gave one, because "held — systolic
 * 84" is the entire clinical content of that row.
 */
export function DoseRow({
  dose,
  zone,
}: {
  dose: MedicationAdministration;
  zone: string;
}): React.JSX.Element {
  const theme = useTheme();
  const at = parseInstant(dose.administeredAt);

  return (
    <View style={[styles.entry, { borderTopColor: theme.colors.border }]}>
      <View style={styles.row}>
        <Text style={[typography.body, styles.drug, { color: theme.colors.fg }]} numberOfLines={2}>
          {dose.drugName}
        </Text>
        <Pill label={marStatusLabel(dose.status)} tone={marStatusTone(dose.status)} />
      </View>

      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>
        {dose.dose} · {dose.route}
        {at ? ` · ${formatRelativeDay(at, zone)} ${formatTime(at, { zone })}` : ""}
      </Text>

      {dose.reason ? (
        <Text style={[typography.caption, { color: theme.colors.warning }]}>{dose.reason}</Text>
      ) : null}
      {dose.note ? (
        <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>{dose.note}</Text>
      ) : null}
    </View>
  );
}

function Labelled({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.labelled}>
      <Text style={[typography.caption, { color: theme.colors.fgMuted }]}>{label}</Text>
      <Text style={[typography.body, { color: theme.colors.fg }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[2],
  },
  /**
   * A hairline between entries rather than a card each. A ward round scrolls a dozen of these, and
   * twelve stacked cards is twelve borders and twelve gaps of wasted vertical space on a phone.
   */
  entry: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space[2], gap: space[1] },
  drug: { flex: 1, fontWeight: "600" },
  labelled: { gap: 2 },
});
