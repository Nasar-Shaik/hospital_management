/**
 * Who the patient is — the line every clinical screen opens with.
 *
 * ── THE LISTS NO LONGER COME HERE, AND THAT WAS THE POINT ───────────────────
 * This file used to carry a note saying `GET /encounters` returned `patientId` and no identity at
 * all, that the web app worked around it by pulling the first 100 patients and matching locally
 * (silently rendering "—" for patient 101), and that the honest version on a phone was a
 * per-patient read — N reads for N rows — with the observation that "an API change would pay for
 * itself: a patient summary embedded in the encounter list".
 *
 * It did. `GET /encounters` and `GET /inpatients` now return `EncounterRow`, which names its
 * patient, so a list of twenty costs ONE request; the web app's silent dash was the defect that
 * finally paid for it (D18). `EncounterRow.tsx` and `inpatients.tsx` read the row.
 *
 * What is left here is what a list cannot answer: a SINGLE patient behind an id, on a screen that
 * was reached with an id and nothing else — the order detail, the prescribing screen. There the
 * per-patient read is not a workaround, it is the only question being asked, and the cache entry
 * it fills is the same one the patient screen opens with.
 */
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { Allergy, Patient } from "@medicore/api-client";
import { useTheme } from "../../hooks/useTheme";
import { useClinical, useZoneFor } from "../../hooks/useClinical";
import { space, typography } from "../../theme/tokens";
import { demographics, isSupersededRecord } from "../../clinical/patient";
import { Pill } from "../Pill";

/**
 * A name does not change during a ward round.
 *
 * Exported because every observer of the patient key must agree on it: React Query takes the
 * MINIMUM `staleTime` across observers, so one screen that forgot it would re-fetch the names for
 * everybody — twenty requests per revisit instead of twenty per round.
 */
export const PATIENT_STALE_MS = 5 * 60_000;

/** The patient behind an id, or `undefined` while it resolves. Shared by every row and screen. */
export function usePatient(patientId: string | undefined): Patient | undefined {
  const { queries, ready } = useClinical();
  const read = queries.patient(patientId ?? "");
  const { data } = useQuery({
    ...read,
    enabled: ready && Boolean(patientId),
    staleTime: PATIENT_STALE_MS,
  });
  return data;
}

/** `Meera Nair · UHID 100042` — the list-row form. Falls back to the id, never to a blank. */
export function PatientName({
  patientId,
  size: variant = "body",
}: {
  patientId: string;
  size?: "body" | "title";
}): React.JSX.Element {
  const theme = useTheme();
  const patient = usePatient(patientId);
  const style = variant === "title" ? typography.title : typography.heading;

  return (
    <Text style={[style, { color: theme.colors.fg }]} numberOfLines={1}>
      {patient?.name ?? "Loading patient…"}
    </Text>
  );
}

/**
 * The full identity block: name, then the wristband number, then age and sex.
 *
 * The order is fixed — UHID second, always — because it is the only field in the record a nurse can
 * physically check against the patient in front of her.
 */
export function PatientIdentity({ patient }: { patient: Patient }): React.JSX.Element {
  const theme = useTheme();
  const zoneFor = useZoneFor();
  const superseded = isSupersededRecord(patient);

  /**
   * Age is a calendar fact, so "today" has to be the hospital's today and not the phone's — the
   * same rule as every timestamp on the chart, arriving through a different door. See `ageInYears`.
   * A patient record carries no branch of its own, so this is the reader's active site, which is
   * the right answer for the one screen that shows a full identity block.
   */
  const zone = zoneFor(undefined);

  return (
    <View style={styles.identity}>
      <Text style={[typography.title, { color: theme.colors.fg }]}>{patient.name}</Text>
      <Text
        style={[typography.body, styles.uhid, { color: theme.colors.fgMuted }]}
        accessibilityLabel={`UHID ${patient.uhid.split("").join(" ")}`}
      >
        UHID {patient.uhid}
      </Text>
      <View style={styles.meta}>
        <Text style={[typography.body, { color: theme.colors.fgMuted }]}>
          {demographics(patient, new Date(), zone)}
        </Text>
        {patient.bloodGroup ? (
          <Text style={[typography.body, { color: theme.colors.fgMuted }]}>
            · {patient.bloodGroup}
          </Text>
        ) : null}
      </View>

      {/* A merged record still reads perfectly — name, UHID, history — and writing against it puts
          a note on a chart nobody opens again. Saying so is the only protection there is. */}
      {superseded ? <Pill label="Merged — not the live chart" tone="warning" /> : null}
    </View>
  );
}

/**
 * Known allergies, above everything clinical.
 *
 * ── "NO KNOWN ALLERGIES" AND "NOT LOADED YET" ARE DIFFERENT SENTENCES ───────
 * Both look like an empty banner, and one of them is a promise the record cannot keep. While the
 * list is loading this says so; only once the server has answered does it state that nothing is
 * recorded. The server's prescribing check is the real gate — this is so a doctor is never
 * surprised by it.
 */
export function AllergyBanner({
  allergies,
  loading,
}: {
  allergies: readonly Allergy[] | undefined;
  loading: boolean;
}): React.JSX.Element {
  const theme = useTheme();

  if (loading || !allergies) {
    return (
      <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
        Checking allergies…
      </Text>
    );
  }

  const active = allergies.filter((allergy) => allergy.status === "active");
  if (active.length === 0) {
    return (
      <Text style={[typography.caption, { color: theme.colors.fgSubtle }]}>
        No known drug allergies recorded.
      </Text>
    );
  }

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`Allergies: ${active.map((a) => a.label).join(", ")}`}
      style={[
        styles.allergies,
        { backgroundColor: theme.colors.dangerBg, borderColor: theme.colors.danger },
      ]}
    >
      <Text style={[typography.label, { color: theme.colors.danger }]}>ALLERGIES</Text>
      <View style={styles.allergyRow}>
        {active.map((allergy) => (
          <Pill
            key={allergy.id}
            tone="critical"
            label={
              allergy.severity === "anaphylaxis" || allergy.severity === "severe"
                ? `${allergy.label} (${allergy.severity})`
                : allergy.label
            }
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  identity: { gap: space[1] },
  // A UHID is read digit by digit off a wristband; proportional spacing makes that harder.
  uhid: { fontVariant: ["tabular-nums"] },
  meta: { flexDirection: "row", gap: space[1], flexWrap: "wrap" },
  allergies: { borderWidth: 1, borderRadius: 12, padding: space[3], gap: space[2] },
  allergyRow: { flexDirection: "row", flexWrap: "wrap", gap: space[1] },
});
