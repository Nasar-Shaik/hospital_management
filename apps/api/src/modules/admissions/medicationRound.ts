/**
 * The medication round (M3-S5B) — one page of a ward with every dose expected on it today, and
 * what has happened to each.
 *
 * ── WHY THIS ENDPOINT EXISTS, WHEN TWO OTHERS NEARLY DID ────────────────────
 * `GET /ward-worklist` (S3) says a patient has *three doses due*. `GET /encounters/:id/
 * medication-schedule` (S1) says *which* three. A drug round needs the second for every patient on
 * the ward at once, and assembling that from the per-encounter endpoint is
 *
 *     1 (worklist) + 1 (bed board, for names) + N (schedules)
 *
 * — a request per patient, on hospital wifi, which is the exact N+1 the worklist was built to
 * remove. So the batch happens where the data already is: **five queries, whatever the page size**
 * — the inpatient page, then one `$in` each for names, allergies, live prescriptions and
 * administrations. The slots are arithmetic on data already in memory.
 *
 * ── IT IS NOT A SECOND SCHEDULING ENGINE ────────────────────────────────────
 * Not one dose time is computed here. `slotsForStay` is the MAR module's own derivation — the same
 * function `getSchedule` calls — invoked once per stay over the batched rows. That is deliberate
 * and it is the point: the round is the screen a nurse decides from, the schedule is the oracle the
 * confirmation screen re-reads a heartbeat later, and a round that said "due" where the schedule
 * said "given" would send somebody to give a second dose. They cannot disagree, because they are
 * one function.
 *
 * ── THE CLINICAL DAY IS THE WARD'S, NEVER THE CALLER'S ──────────────────────
 * `date` is resolved in the BRANCH's timezone. A nurse whose handset is in another zone — or
 * simply set wrong — cannot shift which day's round they are working. Absent, the server resolves
 * today itself, so a client that names no day still gets the ward's day rather than the process's.
 *
 * ── IDENTITY IS ON THE ROW, NOT JOINED IN AFTERWARDS ────────────────────────
 * `WorklistRow` deliberately carries no name; S3's screen enriches it from `/bed-board`, and when
 * that read is missing the row still identifies the patient by bed. That trade is right for a
 * navigation list and wrong for a medication row: a dose against "Patient · bed A-01" is exactly
 * the ambiguity the five rights exist to close. So the name and UHID are resolved here, in the
 * same batch, and a round row is never rendered without them.
 */
import { dayKeyInZone, dayRangeInZone } from "../../core/time/day.js";
import { branchZone } from "../branches/index.js";
import { listInpatients } from "../encounters/index.js";
import { activeForPatients } from "../allergies/index.js";
import { namesByIds } from "../patients/index.js";
import { listForEncounters, type Prescription } from "../prescriptions/index.js";
import {
  listByEncounters,
  slotsForStay,
  isLive,
  isOutstanding,
  type DoseSlotView,
  type MedicationAdministration,
} from "../mar/index.js";

/** One patient on the round, and every dose expected of them on the chosen ward day. */
export interface MedicationRoundRow {
  encounterId: string;
  patientId: string;
  /** Resolved server-side, in the same batch. Never absent on a row that renders. */
  patientName: string;
  uhid: string;
  /** The bed as recorded at admission — free text, which is why the ward filter matches on it. */
  ward?: string;
  bedCode?: string;
  /** Active allergens, by code. HOSPITAL-WIDE: never narrowed to a branch. */
  allergens: string[];
  /** True when any active allergy is `severe` — the one distinction a round acts on immediately. */
  severeAllergy: boolean;
  /**
   * Every dose on the chosen day, earliest first, answered or not. The identical shape the
   * per-encounter schedule returns, so a client learns ONE dose type and the round hands the
   * confirmation screen a slot it already understands.
   */
  slots: DoseSlotView[];
  /** Outstanding doses — a count of `slots`, kept here so the phone reads it rather than deriving it. */
  dosesDue: number;
  /** Of those, the ones already past their round. A subset of `dosesDue`, never additional. */
  dosesOverdue: number;
}

export interface MedicationRoundPage {
  items: MedicationRoundRow[];
  total: number;
  /** The clinical day actually used, `YYYY-MM-DD` in the ward's zone. Echoed so nobody guesses. */
  date: string;
}

export interface MedicationRoundFilter {
  ward?: string;
  /** `YYYY-MM-DD`. Absent means today IN THE WARD'S ZONE, resolved here. */
  date?: string;
  limit: number;
  skip: number;
}

/**
 * One page of the round.
 *
 * Paged in the database in bed order (`listInpatients` sorts ward → bed → id), exactly like the
 * worklist. Ordering by urgency is the CLIENT's job over what it has loaded — doing it here would
 * mean deriving every slot for every patient in the ward before the first page could be cut, which
 * turns a bounded request into an unbounded one on a 300-bed site.
 */
export async function medicationRound(filter: MedicationRoundFilter): Promise<MedicationRoundPage> {
  const { items: encounters, total } = await listInpatients({
    limit: filter.limit,
    skip: filter.skip,
    ...(filter.ward ? { ward: filter.ward } : {}),
  });

  // The zone still has to be resolved for an empty page: the caller is told which day it asked
  // about, and "no patients" must not come back dated by the process clock.
  const zone = await branchZone(encounters[0]?.branchId);
  const date = filter.date ?? dayKeyInZone(new Date(), zone);
  if (encounters.length === 0) return { items: [], total, date };

  const encounterIds = encounters.map((e) => e.id);
  const patientIds = [...new Set(encounters.map((e) => e.patientId))];

  const [names, allergies, prescriptions, administrations] = await Promise.all([
    namesByIds(patientIds),
    activeForPatients(patientIds),
    listForEncounters(encounterIds),
    listByEncounters(encounterIds),
  ]);

  const { from, before } = dayRangeInZone(date, zone);
  const now = Date.now();

  const nameById = new Map(names.map((n) => [n.id, n]));
  const allergyByPatient = groupBy(allergies, (a) => a.patientId);
  const rxByEncounter = groupBy(prescriptions.filter(isLive), (p: Prescription) => p.encounterId);
  const marByEncounter = groupBy(administrations, (a: MedicationAdministration) => a.encounterId);

  const items = encounters.map((encounter) => {
    const who = nameById.get(encounter.patientId);
    const patientAllergies = allergyByPatient.get(encounter.patientId) ?? [];
    const slots = slotsForStay({
      prescriptions: rxByEncounter.get(encounter.id) ?? [],
      administrations: marByEncounter.get(encounter.id) ?? [],
      zone,
      from,
      before,
      now,
    });
    const outstanding = slots.filter(isOutstanding);

    return {
      encounterId: encounter.id,
      patientId: encounter.patientId,
      // The board says "Unknown patient" in the same situation, and for the same reason: a row
      // that silently drops its identity is worse than one that says the lookup failed.
      patientName: who?.name ?? "Unknown patient",
      uhid: who?.uhid ?? "",
      ...(encounter.bed?.ward ? { ward: encounter.bed.ward } : {}),
      ...(encounter.bed?.bedCode ? { bedCode: encounter.bed.bedCode } : {}),
      allergens: patientAllergies.map((a) => a.allergen),
      severeAllergy: patientAllergies.some((a) => a.severity === "severe"),
      slots,
      dosesDue: outstanding.length,
      dosesOverdue: outstanding.filter((s) => s.state === "overdue").length,
    } satisfies MedicationRoundRow;
  });

  return { items, total, date };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}
