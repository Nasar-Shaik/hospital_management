/**
 * Emergency department service (D10).
 *
 * ── THIS MODULE ORCHESTRATES; IT DOES NOT REIMPLEMENT ───────────────────────
 * Registration is `encounters`. The lifecycle is `encounters`. Orders, prescriptions, imaging,
 * admission and discharge are the modules that already own them, reached through the same routes
 * the rest of the hospital uses — an ED doctor ordering a CBC places the SAME order a ward doctor
 * places, and it lands on the same bench.
 *
 * What is added here is the one fact the encounter cannot hold (how sick this person is, judged by
 * someone, at a time) and the one view nothing else produces (all of it, ranked).
 */
import { AppError } from "../../core/errors/appError.js";
import { getContext } from "../../core/context/requestContext.js";
import {
  closeEncounter,
  getEncounter,
  listEncounters,
  startConsultation,
  type Encounter,
} from "../encounters/index.js";
import { namesByIds } from "../patients/index.js";
import * as repo from "./emergency.repository.js";
import { PRIORITY_RANK, UNTRIAGED_RANK, type TriagePriority } from "./emergency.model.js";

export type { Triage } from "./emergency.repository.js";

/** An ED visit, and only an ED visit. Everything here refuses an encounter of another class. */
async function requireEdEncounter(encounterId: string): Promise<Encounter> {
  const encounter = await getEncounter(encounterId);
  if (!encounter) throw new AppError("HMS-GEN-404", 404, "Visit not found", { id: encounterId });
  if (encounter.class !== "ER") {
    /**
     * A 409 rather than a 404: the visit exists and the caller may read it — what is wrong is
     * that an outpatient consultation is not an emergency presentation, and triaging one would
     * put a patient on the ED board who is not in the emergency department.
     */
    throw new AppError("HMS-VAL-001", 409, "That visit is not an emergency presentation", {
      class: encounter.class,
      hint: "register the patient with class ER to work them up in the emergency department",
    });
  }
  return encounter;
}

export interface TriageInput {
  encounterId: string;
  priority: TriagePriority;
  chiefComplaint?: string;
}

/**
 * Assess an ED patient, or re-assess one.
 *
 * Triage does NOT move the encounter's state. That is deliberate: a triaged patient may be waiting
 * (`in_queue`), already with a doctor (`in_progress`), or still `arrived` while the nurse works
 * down the queue — and coupling the two would mean a re-triage silently dragged a patient back out
 * of the consulting room. Priority is a property of the patient; the queue is a property of the
 * visit; the board shows both.
 */
export async function triage(input: TriageInput): Promise<repo.Triage> {
  const encounter = await requireEdEncounter(input.encounterId);
  const by = getContext().userId;
  return repo.recordTriage({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    priority: input.priority,
    ...(input.chiefComplaint ? { chiefComplaint: input.chiefComplaint } : {}),
    ...(by ? { triagedBy: by } : {}),
  });
}

export interface TransferOutInput {
  encounterId: string;
  destination: string;
  note?: string;
}

/** Where the visit is when the decision to divert is taken, but before anyone has called them in. */
const NOT_YET_SEEN: readonly string[] = ["arrived", "in_queue"];

/**
 * The patient left for another hospital.
 *
 * TWO writes, in this order and not the other: record WHERE they went, then close the visit. If the
 * close fails, the department still has a record of a patient who left in an ambulance; if the
 * order were reversed and the record failed, the visit would be closed with no explanation at all —
 * and "closed" would be read forever after as "went home".
 *
 * ── WHY A NOT-YET-SEEN PATIENT IS STARTED FIRST ─────────────────────────────
 * `arrived → closed` is not a legal edge, deliberately: closing a visit asserts the consultation
 * happened, and an OP patient must not be closed without being seen. But an ED patient CAN leave
 * without ever reaching a queue — a crash victim diverted to a trauma centre on sight — and the
 * two honest-looking alternatives are both wrong:
 *
 *   `left_without_being_seen` means the patient gave up and went home. Filing a diverted trauma
 *   case under it corrupts the LWBS rate, which is one of the few numbers that predicts a patient
 *   coming back sicker (encounter.model.ts).
 *
 *   Adding `arrived → closed` to the shared machine would let ANY outpatient visit be closed
 *   without a consultation, everywhere in the product, to solve an emergency-department problem.
 *
 * So the visit is walked the legal way, and the walk is TRUE: this route needs `encounter:close`,
 * which the doctor holds, and a doctor deciding to divert a patient has assessed them. That contact
 * is what `in_progress` records. Recording it as never-started would be the false version.
 *
 * The transitions are the ENCOUNTER module's own — this module has no business ending a visit its
 * own way, and does not.
 */
export async function transferOut(input: TransferOutInput): Promise<repo.Triage> {
  const encounter = await requireEdEncounter(input.encounterId);
  const by = getContext().userId;

  const record = await repo.recordTransfer({
    encounterId: encounter.id,
    patientId: encounter.patientId,
    destination: input.destination,
    ...(input.note ? { note: input.note } : {}),
    ...(by ? { by } : {}),
  });

  if (NOT_YET_SEEN.includes(encounter.status)) await startConsultation(encounter.id);
  await closeEncounter(encounter.id, `Transferred to ${input.destination}`);
  return record;
}

/* ── the board ──────────────────────────────────────────────────────────────── */

export interface EdBoardRow {
  encounterId: string;
  patientId: string;
  patientName: string;
  uhid: string;
  arrivedAt: string;
  /** Whole minutes since arrival, computed on the SERVER — see below. */
  waitingMinutes: number;
  priority?: TriagePriority;
  chiefComplaint?: string;
  triagedAt?: string;
  status: string;
  doctorId?: string;
  token?: number;
}

/**
 * Everyone currently in the emergency department, worst first.
 *
 * ── WHY THE WAIT IS COMPUTED HERE ───────────────────────────────────────────
 * A browser that subtracts `arrivedAt` from its own clock reports the wait as the DEVICE sees it,
 * and a wall-mounted board with a drifting clock then quietly disagrees with the nurse's phone
 * about how long somebody has been waiting. One clock, the server's, same as `flags` on vitals.
 *
 * ── AND WHY IT IS NOT DATE-FILTERED ─────────────────────────────────────────
 * An ED does not have days. A patient brought in at 23:50 is still in the department at 00:10, and
 * a board that reset at midnight would drop the night shift's sickest patient off the screen. The
 * filter is the encounter being OPEN — the patient leaves the board when they are discharged,
 * admitted, transferred out or recorded as having left, and not before.
 */
export async function board(): Promise<EdBoardRow[]> {
  const page = await listOpenEdEncounters();
  if (page.length === 0) return [];

  const [triages, names] = await Promise.all([
    repo.findByEncounters(page.map((e) => e.id)),
    namesByIds([...new Set(page.map((e) => e.patientId))]),
  ]);
  const triageBy = new Map(triages.map((t) => [t.encounterId, t]));
  const nameBy = new Map(names.map((n) => [n.id, n]));

  const now = Date.now();
  const rows: EdBoardRow[] = page.map((e) => {
    const t = triageBy.get(e.id);
    const arrived = e.arrivedAt.getTime();
    return {
      encounterId: e.id,
      patientId: e.patientId,
      patientName: nameBy.get(e.patientId)?.name ?? "Unknown patient",
      uhid: nameBy.get(e.patientId)?.uhid ?? "—",
      arrivedAt: e.arrivedAt.toISOString(),
      waitingMinutes: Math.max(0, Math.floor((now - arrived) / 60_000)),
      ...(t?.priority ? { priority: t.priority } : {}),
      ...(t?.chiefComplaint ? { chiefComplaint: t.chiefComplaint } : {}),
      ...(t?.triagedAt ? { triagedAt: t.triagedAt } : {}),
      status: e.status,
      ...(e.doctorId ? { doctorId: e.doctorId } : {}),
      ...(e.token !== undefined ? { token: e.token } : {}),
    };
  });

  /**
   * Rank first, then the longest wait. Untriaged is rank 0 — see `UNTRIAGED_RANK`: an unassessed
   * patient's severity is unknown, and the one thing a board must never do is let unknown drift to
   * the bottom because it sorted as "no priority".
   */
  return rows.sort((a, b) => {
    const ra = a.priority ? PRIORITY_RANK[a.priority] : UNTRIAGED_RANK;
    const rb = b.priority ? PRIORITY_RANK[b.priority] : UNTRIAGED_RANK;
    if (ra !== rb) return ra - rb;
    return a.arrivedAt.localeCompare(b.arrivedAt);
  });
}

/**
 * The open ER-class encounters at this caller's scope.
 *
 * Read through the encounters module's public list rather than by querying its collection: the
 * emergency department does not own encounters, and a second query against them would be a second
 * definition of "still here" that could drift from the one `isOpen` states.
 *
 * `openOnly`, not `queuedOnly`: the queue board's filter drops `arrived`, and a patient who has
 * just been brought in and not yet put in a queue is the single most important row on an ED board.
 *
 * The 200 ceiling is the department's physical capacity with a wide margin. An ED holding more than
 * two hundred OPEN encounters is not a paging problem — it is either a mass-casualty incident or a
 * hospital that has stopped closing visits, and truncating the board is the correct failure in the
 * first case and the visible symptom in the second.
 */
async function listOpenEdEncounters(): Promise<Encounter[]> {
  const { items } = await listEncounters({
    openOnly: true,
    encounterClass: "ER",
    limit: 200,
    skip: 0,
  });
  return items;
}
