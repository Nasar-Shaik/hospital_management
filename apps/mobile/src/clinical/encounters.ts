/**
 * How a visit is described to a clinician — labels, tone, and the order of a round.
 *
 * ── PRESENTATION ONLY. THE STATE MACHINE IS THE SERVER'S ────────────────────
 * Nothing here decides what may happen next; `EncounterStatus` arrives decided. What this owns is
 * the translation from a wire enum to something readable at arm's length on a ward, in ONE place,
 * so `awaiting_results` does not become "Awaiting results" on one screen and "At lab" on another.
 *
 * Kept out of the components deliberately: a label table inside a `.tsx` file is a label table
 * that cannot be tested without a renderer, and this suite runs in Node.
 */
import type { Encounter, EncounterStatus } from "@medicore/api-client";

/** The severity a status is drawn in. Maps to theme tokens at the component, never to hex here. */
export type ClinicalTone = "neutral" | "active" | "waiting" | "warning" | "critical" | "done";

/**
 * Wording chosen from the ward's vocabulary rather than the schema's.
 *
 * `left_without_being_seen` is the one worth reading twice: it is not a cancellation and must not
 * be softened into one — a patient who gave up and went home is a clinical governance event.
 */
const STATUS_LABEL: Record<EncounterStatus, string> = {
  planned: "Planned",
  arrived: "Arrived",
  in_queue: "Waiting",
  in_progress: "With you now",
  awaiting_results: "Awaiting results",
  closed: "Closed",
  cancelled: "Cancelled",
  left_without_being_seen: "Left without being seen",
  admitted: "Admitted",
};

const STATUS_TONE: Record<EncounterStatus, ClinicalTone> = {
  planned: "neutral",
  arrived: "waiting",
  in_queue: "waiting",
  in_progress: "active",
  awaiting_results: "warning",
  closed: "done",
  cancelled: "neutral",
  left_without_being_seen: "warning",
  admitted: "active",
};

export function encounterStatusLabel(status: EncounterStatus): string {
  return STATUS_LABEL[status];
}

export function encounterStatusTone(status: EncounterStatus): ClinicalTone {
  return STATUS_TONE[status];
}

const CLASS_LABEL: Record<Encounter["class"], string> = {
  OP: "Outpatient",
  IP: "Inpatient",
  ER: "Emergency",
  TELE: "Teleconsult",
  HOME: "Home visit",
};

export function encounterClassLabel(kind: Encounter["class"]): string {
  return CLASS_LABEL[kind];
}

/** Statuses that mean the patient is still this doctor's problem today. */
const LIVE: ReadonlySet<EncounterStatus> = new Set<EncounterStatus>([
  "planned",
  "arrived",
  "in_queue",
  "in_progress",
  "awaiting_results",
]);

export function isLiveEncounter(encounter: Pick<Encounter, "status">): boolean {
  return LIVE.has(encounter.status);
}

/**
 * The order a doctor's list is worked in.
 *
 * ── TOKEN ORDER IS ARRIVAL ORDER, AND THAT IS THE FAIRNESS RULE ─────────────
 * The waiting room can see who came first. Any other default ordering — alphabetical, by acuity,
 * by whoever was tapped last — reads as queue-jumping from the corridor, so it is not offered.
 * `express` is the one documented exception: it is a paid fast-track the hospital sells, and the
 * server already sorts it above normal patients in the queue endpoint. Sorting it here too keeps
 * a locally-filtered list looking like the server's.
 *
 * Someone already IN the room outranks everyone waiting — you finish a consultation before you
 * start another — and a patient with no token (never issued, by hospital policy) sorts after those
 * with one rather than to the top, which is where `undefined` would otherwise land.
 */
export function sortForRound<T extends Encounter>(encounters: readonly T[]): T[] {
  const rank = (e: Encounter): number => (e.status === "in_progress" ? 0 : e.express ? 1 : 2);
  return [...encounters].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byToken = (a.token ?? Number.MAX_SAFE_INTEGER) - (b.token ?? Number.MAX_SAFE_INTEGER);
    if (byToken !== 0) return byToken;
    return a.arrivedAt.localeCompare(b.arrivedAt);
  });
}

/** What the home screen counts. Derived from one already-fetched page, not a second request. */
export interface RoundSummary {
  total: number;
  waiting: number;
  inProgress: number;
  awaitingResults: number;
}

export function summariseRound(encounters: readonly Encounter[]): RoundSummary {
  let waiting = 0;
  let inProgress = 0;
  let awaitingResults = 0;
  for (const encounter of encounters) {
    if (encounter.status === "in_queue" || encounter.status === "arrived") waiting += 1;
    if (encounter.status === "in_progress") inProgress += 1;
    if (encounter.status === "awaiting_results") awaitingResults += 1;
  }
  return { total: encounters.length, waiting, inProgress, awaitingResults };
}
