/**
 * The inpatient stay, as a ward round reads it: where the patient is, how long they have been
 * there, and what has been given.
 *
 * ── THERE IS NO ADMISSION OBJECT, AND THIS FILE DOES NOT INVENT ONE ─────────
 * ADR-0013 §1: **the IP encounter IS the admission.** The bed, `admittedAt`, `dischargedAt` and
 * the disposition all live on the encounter, and the OPD visit that preceded it is a SEPARATE
 * encounter in the SAME episode (§4). That is why the chart needs no second architecture for
 * inpatients — the timeline the doctor already reads is the episode, and the admission is one more
 * encounter on it. A mobile "Admission" model would be a third copy of a thing the server
 * deliberately does not have.
 *
 * ── OCCUPANCY IS THE SERVER'S, ALWAYS ───────────────────────────────────────
 * Two different counts appear on the ward screen and they must not be confused:
 *
 *   the ROUND count   — how many rows are in this ward on MY list. Derived here, because it is a
 *                       property of the list being displayed and nothing else.
 *   the OCCUPANCY     — free / occupied / blocked. Comes only from `GET /bed-board`, which derives
 *                       it from open IP encounters inside one query. Never recomputed here: a
 *                       phone that counted "occupied" from a page of twenty rows would report a
 *                       forty-bed ward as nearly empty, and a bed board that disagrees with the
 *                       ward clerk's is worse than no bed board.
 *
 * ── THE TWO ENDPOINTS ARE JOINED, NOT CHOSEN BETWEEN ────────────────────────
 * `GET /inpatients` is the clinical list — who is admitted, their encounter, their status. It
 * carries `patientId` and no name (the same identity gap the OPD list has).
 * `GET /bed-board` is the estate — wards, rooms, beds, and for every occupied bed the occupant's
 * NAME and UHID, resolved server-side in one query.
 *
 * Joining them on `encounterId` gives a round list with real identity for nothing: no per-patient
 * lookups, no hundred-patient prefetch. The board is the enrichment and the inpatient list is the
 * truth about who is admitted — so a patient the board has not heard of still appears, in a group
 * that says so, rather than vanishing because the bed inventory is incomplete.
 */
import type {
  BedBoard,
  DoseSlot,
  Encounter,
  MarStatus,
  MedicationAdministration,
  WardKind,
} from "@medicore/api-client";
import { formatDayKey } from "../lib/time";
import type { ClinicalTone } from "./encounters";

/* ════════════════════════════════════════════════════════════════════════════
 * WHERE THE PATIENT IS
 * ══════════════════════════════════════════════════════════════════════════ */

/** Where a stay is, as the round needs to read it aloud: ward, room, bed. */
export interface Placement {
  wardName: string;
  wardKind?: WardKind;
  /** The first-class room, or the legacy free-text label — whichever the estate has. */
  roomName?: string;
  bedCode: string;
  /**
   * True when the bed board recognised this bed. False for a legacy free-text admission, which is
   * shown as-is rather than hidden — the ward can SEE that somebody is in a bed the inventory does
   * not know about, which is the first step to fixing the inventory.
   */
  inInventory: boolean;
}

/** The label a doctor navigates by. `General ward · Room 2 · bed 14`. */
export function placementLabel(placement: Placement | undefined): string {
  if (!placement) return "Bed not recorded";
  const parts = [placement.wardName];
  if (placement.roomName) parts.push(placement.roomName);
  parts.push(`bed ${placement.bedCode}`);
  return parts.join(" · ");
}

/**
 * Every occupied bed on the board, keyed by the ENCOUNTER it holds.
 *
 * `encounterId` is the join key because it is the only identifier both sides agree on and cannot
 * be ambiguous: a patient may have had ten stays, but exactly one open IP encounter (migration
 * 0012's unique partial index guarantees it), and the board is built from those.
 */
export function placementsByEncounter(board: BedBoard | undefined): Map<string, Placement> {
  const found = new Map<string, Placement>();
  if (!board) return found;

  for (const ward of board.wards) {
    for (const bed of ward.beds) {
      if (!bed.occupant) continue;
      found.set(bed.occupant.encounterId, {
        wardName: ward.name,
        wardKind: ward.kind,
        ...((bed.roomName ?? bed.room) ? { roomName: bed.roomName ?? bed.room } : {}),
        bedCode: bed.code,
        inInventory: true,
      });
    }
  }

  // A stay in a bed the catalogue does not have. The board reports these separately rather than
  // dropping them, and so does this.
  for (const stay of board.unlisted) {
    found.set(stay.encounterId, {
      wardName: stay.ward,
      bedCode: stay.bedCode,
      inInventory: false,
    });
  }

  return found;
}

/** Name and UHID for every admitted patient, from the board — no per-row `getPatient`. */
export function identitiesByEncounter(
  board: BedBoard | undefined,
): Map<string, { patientName: string; uhid: string }> {
  const found = new Map<string, { patientName: string; uhid: string }>();
  if (!board) return found;

  for (const ward of board.wards) {
    for (const bed of ward.beds) {
      if (!bed.occupant) continue;
      found.set(bed.occupant.encounterId, {
        patientName: bed.occupant.patientName,
        uhid: bed.occupant.uhid,
      });
    }
  }
  for (const stay of board.unlisted) {
    found.set(stay.encounterId, { patientName: stay.patientName, uhid: stay.uhid });
  }
  return found;
}

/**
 * The stay's own recorded bed, when the board has nothing to say about it.
 *
 * The encounter carries `bed: { ward, bedCode }` from the admission itself, so a hospital with no
 * bed inventory at all — the board answers with empty wards — still gets a usable round list.
 */
export function placementFor(
  encounter: Pick<Encounter, "id" | "bed">,
  fromBoard: Map<string, Placement>,
): Placement | undefined {
  const board = fromBoard.get(encounter.id);
  if (board) return board;
  if (!encounter.bed) return undefined;
  return { wardName: encounter.bed.ward, bedCode: encounter.bed.bedCode, inInventory: false };
}

/* ════════════════════════════════════════════════════════════════════════════
 * HOW LONG THEY HAVE BEEN THERE
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * "Day 3" — which day of the admission today is, counted in the BRANCH's calendar.
 *
 * ── WHY CALENDAR DAYS AND NOT ELAPSED HOURS ─────────────────────────────────
 * It is how a ward counts and how the stay bills. A patient admitted at 23:40 is on day 2 twenty
 * minutes later, because the ward has turned over and the bed-day has been charged — an
 * hours-since-admission figure would say "day 1" for another twenty-three hours and disagree with
 * every other number in the hospital.
 *
 * ── AND WHY THE ZONE IS NOT OPTIONAL ────────────────────────────────────────
 * The day boundary is a wall-clock event at the hospital. Computed against a phone left in UTC, a
 * patient admitted at 04:00 IST would be counted from the previous day and every stay in the ward
 * would read one day long. The zone comes from the validated branch list, never from the device.
 */
export function dayOfStay(admittedAt: Date, now: Date, zone: string): number {
  const from = Date.parse(`${formatDayKey(admittedAt, zone)}T00:00:00Z`);
  const to = Date.parse(`${formatDayKey(now, zone)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 1;
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/** Has this stay ended? `dischargedAt` is set atomically with `closed` — see `clinical/discharge`. */
export function isStayOpen(encounter: Pick<Encounter, "status" | "dischargedAt">): boolean {
  return encounter.status !== "closed" && !encounter.dischargedAt;
}

/** Only an IP encounter is an admission (ADR-0013 §1). An ER visit is not, however sick. */
export function isAdmission(encounter: Pick<Encounter, "class">): boolean {
  return encounter.class === "IP";
}

const DISPOSITIONS: Record<string, string> = {
  discharged: "Discharged",
  lama: "Left against medical advice",
  absconded: "Absconded",
  deceased: "Deceased",
};

/** How the stay ended, in the server's own words — never inferred from anything else. */
export function dispositionLabel(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;
  return DISPOSITIONS[disposition] ?? disposition;
}

const WARD_KINDS: Record<string, string> = {
  general: "General",
  semi_private: "Semi-private",
  private: "Private",
  icu: "ICU",
  nicu: "NICU",
  picu: "PICU",
  hdu: "HDU",
  maternity: "Maternity",
  emergency: "Emergency",
  isolation: "Isolation",
  daycare: "Day care",
};

export function wardKindLabel(kind: WardKind | undefined): string | undefined {
  if (!kind) return undefined;
  return WARD_KINDS[kind] ?? kind;
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE ROUND LIST
 * ══════════════════════════════════════════════════════════════════════════ */

export interface RoundPatient {
  encounter: Encounter;
  placement?: Placement;
  /** From the bed board when it knows the bed; otherwise the row resolves its own name. */
  patientName?: string;
  uhid?: string;
}

export interface WardGroup {
  /** The ward's name, or the unplaced group's label. Used as the section key. */
  ward: string;
  wardKind?: WardKind;
  patients: RoundPatient[];
  /**
   * The board's own counts for this ward, when the board has it. `undefined` for the unplaced
   * group and for a hospital with no inventory — absent, never zero, because "0 free" and "we do
   * not know" are different sentences and only one of them stops an admission.
   */
  occupancy?: { total: number; free: number; occupied: number; blocked: number };
}

/** Where a stay with no recorded bed goes. Last, and named for what it is. */
export const UNPLACED = "Bed not recorded";

/**
 * The round, grouped by ward, in the order a doctor physically walks it.
 *
 * ── THE SERVER'S SORT IS PRESERVED, NOT REPLACED ────────────────────────────
 * `listInpatients` already sorts by ward then bed code — the repository comment says "the order a
 * doctor physically walks", and it is right. Groups therefore appear in first-appearance order and
 * rows keep their order inside a group, so this function regroups without ever reordering. Sorting
 * the wards alphabetically here would silently override a deliberate clinical decision made one
 * layer down.
 *
 * ── THIS IS DISPLAY GROUPING, NOT FILTERING ─────────────────────────────────
 * Every row that came back is in exactly one group and none is dropped. The list itself was
 * narrowed by `scopeFilter()` server-side; nothing on the phone decides who a doctor may see.
 */
export function groupByWard(
  inpatients: readonly Encounter[],
  board: BedBoard | undefined,
): WardGroup[] {
  const placements = placementsByEncounter(board);
  const identities = identitiesByEncounter(board);
  const occupancy = new Map(board?.wards.map((ward) => [ward.name, ward.counts]) ?? []);

  const groups: WardGroup[] = [];
  const byName = new Map<string, WardGroup>();

  for (const encounter of inpatients) {
    const placement = placementFor(encounter, placements);
    const name = placement?.wardName ?? UNPLACED;

    let group = byName.get(name);
    if (!group) {
      const counts = occupancy.get(name);
      group = {
        ward: name,
        ...(placement?.wardKind ? { wardKind: placement.wardKind } : {}),
        patients: [],
        ...(counts ? { occupancy: counts } : {}),
      };
      byName.set(name, group);
      groups.push(group);
    }

    const identity = identities.get(encounter.id);
    group.patients.push({
      encounter,
      ...(placement ? { placement } : {}),
      ...(identity ? { patientName: identity.patientName, uhid: identity.uhid } : {}),
    });
  }

  // The unplaced group sorts last wherever it appeared: it is the exception, and a doctor scanning
  // for their ward should not have to read past it.
  return [
    ...groups.filter((g) => g.ward !== UNPLACED),
    ...groups.filter((g) => g.ward === UNPLACED),
  ];
}

/**
 * The server capped the list and said nothing about it.
 *
 * `GET /inpatients` is hard-coded to `{ limit: 100, skip: 0 }` in the controller and returns a bare
 * array — the repository computes a `total` and the controller discards it, so there is no `meta`
 * and no `hasMore` to read. A hospital with more than 100 open stays would silently show 100.
 *
 * Exactly 100 rows is therefore the only signal available, and the screen says "there may be more"
 * rather than pretending the list is complete. Reported as an API gap rather than papered over
 * with a second request the endpoint has no parameters to make.
 */
export const INPATIENT_SERVER_CAP = 100;

export function mayBeTruncated(inpatients: readonly unknown[]): boolean {
  return inpatients.length >= INPATIENT_SERVER_CAP;
}

/* ════════════════════════════════════════════════════════════════════════════
 * WHAT HAS BEEN GIVEN — the MAR
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ── THE MAR IS BEHIND A DIFFERENT FLAG FROM THE WARD ────────────────────────
 * `GET /encounters/:id/medication-administrations` is gated on `module.clinical.nursing`, NOT on
 * `module.ops.ipd`. A hospital can have wards and no nursing module, so the chart must survive the
 * MAR being unavailable without losing the rest of the stay — which is why it is its own query
 * with its own `HMS-PLAN-002` handling rather than a field on something else.
 */
const MAR_LABELS: Record<MarStatus, string> = {
  given: "Given",
  held: "Held",
  refused: "Refused",
  not_available: "Not available",
};

export function marStatusLabel(status: MarStatus): string {
  return MAR_LABELS[status];
}

/**
 * A dose that did not go in is a WARNING, never a `critical`.
 *
 * `criticalClinical` is spent on a released critical result and nothing else (`theme/tone.ts`). A
 * held dose is a thing to notice; a potassium of 7.1 is a thing to act on within minutes, and a
 * ward where both are the same red is a ward where neither reads as urgent.
 */
export function marStatusTone(status: MarStatus): ClinicalTone {
  return status === "given" ? "done" : "warning";
}

/** Newest first — on a round, the question is what happened this morning, not last Tuesday. */
export function sortDoses(doses: readonly MedicationAdministration[]): MedicationAdministration[] {
  return [...doses].sort((a, b) => {
    const byTime = Date.parse(b.administeredAt) - Date.parse(a.administeredAt);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  });
}

/** The doses charted on one calendar day AT THE HOSPITAL — see `dayOfStay` for why the zone. */
export function dosesOnDay(
  doses: readonly MedicationAdministration[],
  day: string,
  zone: string,
): MedicationAdministration[] {
  return doses.filter((dose) => {
    const at = new Date(dose.administeredAt);
    return !Number.isNaN(at.getTime()) && formatDayKey(at, zone) === day;
  });
}

export interface MarSummary {
  given: number;
  /** Held, refused or unavailable — the ones a doctor needs to know did NOT go in. */
  missed: number;
}

export function summariseDoses(doses: readonly MedicationAdministration[]): MarSummary {
  let given = 0;
  let missed = 0;
  for (const dose of doses) {
    if (dose.status === "given") given += 1;
    else missed += 1;
  }
  return { given, missed };
}

/* ── the dose SCHEDULE, as distinct from the dose RECORD (M3-S3) ───────────── */

/**
 * What a scheduled slot is showing.
 *
 * The four recorded outcomes carry the tones the MAR already uses, so "given" looks the same
 * wherever it appears. `due` and `overdue` are the SERVER's derivation — see `DoseSlot` in the
 * client — and are never recomputed here.
 */
export function doseStateLabel(state: DoseSlot["state"]): string {
  if (state === "due") return "Due";
  if (state === "overdue") return "Overdue";
  return marStatusLabel(state);
}

export function doseStateTone(state: DoseSlot["state"]): ClinicalTone {
  if (state === "due") return "waiting";
  if (state === "overdue") return "critical";
  return marStatusTone(state);
}

export interface SlotSummary {
  /** Slots nobody has answered yet — `due` plus `overdue`, which is what "outstanding" means. */
  due: number;
  /** A subset of `due`, never additional to it. */
  overdue: number;
  answered: number;
}

/**
 * The heading count for "Due today".
 *
 * `overdue` is counted INSIDE `due` rather than beside it: a nurse reading "3 due · 2 overdue"
 * must not be able to read it as five outstanding doses. The two numbers describe one set.
 */
export function summariseSlots(slots: readonly DoseSlot[]): SlotSummary {
  let due = 0;
  let overdue = 0;
  let answered = 0;
  for (const slot of slots) {
    if (slot.state === "due") due += 1;
    else if (slot.state === "overdue") {
      due += 1;
      overdue += 1;
    } else answered += 1;
  }
  return { due, overdue, answered };
}
