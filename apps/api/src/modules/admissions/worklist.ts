/**
 * The ward worklist (M3-S3) — one page of admitted patients, with the two things a nurse decides
 * from at a glance: what they are allergic to, and what is due.
 *
 * ── WHY THIS ENDPOINT EXISTS AT ALL ─────────────────────────────────────────
 * Every field here is already readable one patient at a time. That is precisely the problem: a
 * twenty-bed ward rendered from the per-patient endpoints costs
 *
 *     1 (inpatients) + 20 (allergies) + 20 (prescriptions) + 20 (administrations) = 61 requests
 *
 * on hospital wifi, before the nurse has touched anything. The M3 audit ruled that out, and S1's
 * schedule design was written with this in mind — "so the nurse worklist can ask this for a whole
 * ward without a query per patient per drug".
 *
 * This costs **five queries, whatever the page size**: the inpatient page, then one `$in` each for
 * allergies, live prescriptions, administrations and the latest observations. The dose slots
 * themselves are arithmetic on data already in memory.
 *
 * ── IT INVENTS NOTHING ──────────────────────────────────────────────────────
 * Every number here is derived by the SAME code the per-patient endpoints use: `dosesInRange`
 * from the MAR module, resolved in the branch's timezone, joined against real administration
 * rows. `due` and `overdue` are computed here rather than on the phone for the reason S1 gives —
 * whether a dose is late depends on the ward's clock, and a handset with the wrong time must not
 * be what decides.
 *
 * ── WHY `admissions` OWNS IT ────────────────────────────────────────────────
 * It is the ward's view of a stay, which is this module's whole subject. The dependency direction
 * stays acyclic: admissions → encounters, mar, allergies, vitals, and nothing depends on
 * admissions.
 */
import { env } from "../../config/env.js";
import { dayKeyInZone, dayRangeInZone } from "../../core/time/day.js";
import { zoneOrDefault } from "../../core/time/zone.js";
import { getBranch } from "../branches/index.js";
import { listInpatients, type Encounter } from "../encounters/index.js";
import { activeForPatients, type Allergy } from "../allergies/index.js";
import { listForEncounters, isDispensable } from "../prescriptions/index.js";
import { listByEncounters, dosesInRange, type Course } from "../mar/index.js";
import { latestForEncounters } from "../vitals/index.js";

/** Mirrors the per-encounter schedule view: a dose is late an hour after its round. */
const OVERDUE_AFTER_MS = 60 * 60 * 1000;

export interface WorklistRow {
  encounterId: string;
  patientId: string;
  /** The bed as recorded at admission — free text, which is why the ward filter matches on it. */
  ward?: string;
  bedCode?: string;
  admittedAt?: string;
  status: string;
  /** Active allergens, by code. Empty means none RECORDED, which is not the same as none. */
  allergens: string[];
  /** True when any active allergy is `severe` — the one distinction a round acts on immediately. */
  severeAllergy: boolean;
  /** Scheduled doses today that nobody has answered yet. */
  dosesDue: number;
  /** Of those, the ones already past their round. A subset of `dosesDue`, never additional. */
  dosesOverdue: number;

  /**
   * When observations were last charted on this stay. Absent means NONE on this admission — which
   * is a fact worth showing, not an empty cell.
   *
   * ── THERE IS DELIBERATELY NO "OBS DUE" HERE ─────────────────────────────────
   * A row could say "obs overdue" only if the domain knew how often this patient is meant to be
   * observed, and it does not: there is no observation-frequency order anywhere in the product.
   * Picking a number — four-hourly, six-hourly — would be a clinical protocol invented in a
   * worklist, and it would mark a stable post-op patient "overdue" on a ward that observes twelve
   * hourly. The nurse gets the time and decides; the software does not pretend to know.
   */
  latestVitalsAt?: string;
  /**
   * Whether that last reading was outside its reference range — the SERVER's `abnormal`, computed
   * by the same `assess()` the chart paints, never re-derived. False when nothing is charted.
   */
  vitalsAbnormal: boolean;
}

export interface WorklistPage {
  items: WorklistRow[];
  total: number;
}

/**
 * One page of the ward.
 *
 * @param ward optional, by NAME — an admission stores its bed as text, so the name is the only
 * key that matches. Filtering happens in the database, not here: a nurse on a 300-bed site must
 * not have to page through the whole hospital to find their own patients.
 */
export async function wardWorklist(filter: {
  ward?: string;
  limit: number;
  skip: number;
}): Promise<WorklistPage> {
  const { items: encounters, total } = await listInpatients(filter);
  if (encounters.length === 0) return { items: [], total };

  const encounterIds = encounters.map((e) => e.id);
  const patientIds = [...new Set(encounters.map((e) => e.patientId))];

  const [allergies, prescriptions, administrations, vitals] = await Promise.all([
    activeForPatients(patientIds),
    listForEncounters(encounterIds),
    listByEncounters(encounterIds),
    // The newest reading per encounter, in one `$in` — the vitals module's own batch read, which
    // exists precisely so a list does not ask per patient (M3-S4).
    latestForEncounters(encounterIds),
  ]);

  /**
   * One zone for the page. Every row on it belongs to the caller's active branch — that is what
   * `listInpatients` scoping guarantees — so resolving per row would be the same lookup repeated.
   */
  const zone = await wardZone(encounters[0]?.branchId);
  const dayKey = dayKeyInZone(new Date(), zone);
  const { from, before } = dayRangeInZone(dayKey, zone);
  const now = Date.now();

  const allergyByPatient = groupBy(allergies, (a) => a.patientId);
  const rxByEncounter = groupBy(prescriptions, (p) => p.encounterId);
  const answered = new Set(
    administrations
      .filter((a) => a.scheduledFor !== undefined && a.lineIndex !== undefined)
      .map((a) => slotKey(a.prescriptionId, a.lineIndex as number, a.scheduledFor as string)),
  );

  const items = encounters.map((encounter) => {
    const patientAllergies = allergyByPatient.get(encounter.patientId) ?? [];
    const lastObs = vitals[encounter.id];
    const { due, overdue } = countDoses(
      rxByEncounter.get(encounter.id) ?? [],
      answered,
      zone,
      from,
      before,
      now,
    );

    return {
      encounterId: encounter.id,
      patientId: encounter.patientId,
      status: encounter.status,
      ...(encounter.bed?.ward ? { ward: encounter.bed.ward } : {}),
      ...(encounter.bed?.bedCode ? { bedCode: encounter.bed.bedCode } : {}),
      ...(encounter.admittedAt ? { admittedAt: encounter.admittedAt.toISOString() } : {}),
      allergens: patientAllergies.map((a) => a.allergen),
      severeAllergy: patientAllergies.some((a) => a.severity === "severe"),
      dosesDue: due,
      dosesOverdue: overdue,
      ...(lastObs ? { latestVitalsAt: lastObs.recordedAt.toISOString() } : {}),
      vitalsAbnormal: lastObs?.abnormal ?? false,
    } satisfies WorklistRow;
  });

  return { items, total };
}

/** Doses expected today on one stay that nobody has answered, and how many are already late. */
function countDoses(
  prescriptions: readonly {
    id: string;
    status: string;
    signedAt?: Date;
    lines: readonly unknown[];
  }[],
  answered: ReadonlySet<string>,
  zone: string,
  from: Date,
  before: Date,
  now: number,
): { due: number; overdue: number } {
  let due = 0;
  let overdue = 0;

  for (const rx of prescriptions) {
    // Same administrability rule as the MAR itself; a draft or a stopped order is not due.
    if (!(isDispensable(rx.status as never) || rx.status === "dispensed")) continue;
    if (!rx.signedAt) continue;

    const lines = rx.lines as readonly { frequency: string; durationDays?: number }[];
    lines.forEach((line, lineIndex) => {
      const course: Course = {
        signedAt: rx.signedAt as Date,
        ...(line.durationDays !== undefined ? { durationDays: line.durationDays } : {}),
      };

      for (const dose of dosesInRange(
        line.frequency as never,
        lineIndex,
        course,
        zone,
        from,
        before,
      )) {
        const iso = dose.scheduledFor.toISOString();
        if (answered.has(slotKey(rx.id, lineIndex, iso))) continue;
        due += 1;
        if (dose.scheduledFor.getTime() + OVERDUE_AFTER_MS < now) overdue += 1;
      }
    });
  }

  return { due, overdue };
}

const slotKey = (prescriptionId: string, lineIndex: number, scheduledFor: string): string =>
  `${prescriptionId}:${String(lineIndex)}:${scheduledFor}`;

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

/** The ward's clock. Never the process zone, never the phone's (M0 §21 item C). */
async function wardZone(branchId?: string): Promise<string> {
  if (!branchId) return env.DEFAULT_TIMEZONE;
  const branch = await getBranch(branchId).catch(() => undefined);
  return zoneOrDefault(branch?.timezone, env.DEFAULT_TIMEZONE);
}

export type { Allergy, Encounter };
