/**
 * The dose schedule — turns a prescription line's frequency into the concrete slots a nurse is
 * expected to chart against (M3-S1).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * Before this, `frequency` was an abbreviation and nothing more. "TDS" sat on the line, the MAR
 * recorded administrations with a free `administeredAt`, and **nothing connected the two**. Three
 * consequences, all bad:
 *
 *   1. There was no "due" list — the nurse's single most important view had no server data.
 *   2. A MISSED dose was undetectable. Absence of a row against nothing is not a signal.
 *   3. There was nothing to make UNIQUE, so the same dose could be charted twice, by two nurses,
 *      silently, for ever (the MAR is append-only). That is the clinical defect S1 exists to fix.
 *
 * A slot gives a dose an IDENTITY. Everything else follows from that.
 *
 * ── COMPUTED, NEVER STORED ──────────────────────────────────────────────────
 * The same call `slots.ts` makes for appointments, and for the same reason in its words: a stored
 * table would be "millions of rows describing something a single row already says". More so here —
 * a stored dose schedule would drift the instant a prescription was cancelled or superseded, and
 * the drift would be silent. The durable rows are the administrations.
 *
 * ── TWO KINDS OF "EVERY" ────────────────────────────────────────────────────
 * This is the part that is easy to get wrong, and it decides DST behaviour:
 *
 *   CLOCK-anchored  (OD, BD, TDS, QID, HS, WEEKLY) — these abbreviations name a DRUG ROUND. "TDS"
 *       means the 08:00, the 14:00 and the 20:00 round. Across a DST transition the round stays at
 *       08:00 on the ward clock, so the UTC instant must shift by an hour. Wall clock is stable.
 *
 *   INTERVAL-anchored (Q4H, Q6H, Q8H) — these name an ELAPSED TIME. "every 8 hours" from the first
 *       dose is a pharmacological instruction about blood levels; it does not care what the clock
 *       says. Across a DST transition the gap stays 8 hours and the wall clock shifts. Elapsed
 *       time is stable.
 *
 * Both are correct, and they are correct in opposite directions. `wallClockInZone` gives the first;
 * plain instant arithmetic gives the second.
 *
 * ── THE TIMES ARE DEFAULT POLICY, NOT CLINICAL TRUTH ────────────────────────
 * `DEFAULT_ROUND_TIMES` is one hospital's drug round. Others round at different hours and some vary
 * by ward. It is isolated in one table, keyed by frequency, so tenant-configurable policy can be
 * introduced later by changing where the table comes from — not by redesigning the MAR. Nothing
 * outside this file knows what o'clock a TDS dose is.
 */
import { dayKeyInZone, wallClockInZone } from "../../core/time/day.js";
import { AppError } from "../../core/errors/appError.js";
import type { DrugFrequency } from "../prescriptions/index.js";

/**
 * How a frequency turns into slots.
 *
 * - `clock`    — fixed wall-clock rounds, every day of the course.
 * - `weekly`   — as `clock`, but only on the weekday the course started.
 * - `interval` — a fixed gap from the first dose.
 * - `single`   — exactly one dose, at the signature. STAT: "now, once".
 * - `prn`      — NO slots, ever. Given on demand, legitimately repeatable.
 */
export type FrequencyKind = "clock" | "weekly" | "interval" | "single" | "prn";

export interface FrequencyPolicy {
  kind: FrequencyKind;
  /** `clock` / `weekly`: minutes from local midnight. */
  times?: number[];
  /** `interval`: hours between doses. */
  everyHours?: number;
}

const at = (hour: number, minute = 0): number => hour * 60 + minute;

/**
 * The default drug round.
 *
 * `Record<DrugFrequency, …>` deliberately: adding a value to `DRUG_FREQUENCIES` without deciding
 * what it means here is a COMPILE ERROR, not a dose that silently never becomes due. The work
 * order's "do not silently ignore an existing enum value", enforced by the type system rather than
 * by a reviewer noticing.
 */
export const DEFAULT_ROUND_TIMES: Record<DrugFrequency, FrequencyPolicy> = {
  /** Once daily — the morning round. */
  OD: { kind: "clock", times: [at(8)] },
  /** Twice daily — morning and evening rounds. */
  BD: { kind: "clock", times: [at(8), at(20)] },
  /** Three times daily. */
  TDS: { kind: "clock", times: [at(8), at(14), at(20)] },
  /** Four times daily — a six-hourly round that still lets the patient sleep. */
  QID: { kind: "clock", times: [at(6), at(12), at(18), at(22)] },
  /** At night (hora somni). */
  HS: { kind: "clock", times: [at(22)] },
  /** Once a week, on the weekday the course started. */
  WEEKLY: { kind: "weekly", times: [at(8)] },

  Q4H: { kind: "interval", everyHours: 4 },
  Q6H: { kind: "interval", everyHours: 6 },
  Q8H: { kind: "interval", everyHours: 8 },

  /**
   * As required. NO slots — and this is load-bearing, not an omission: a PRN analgesic may be
   * given many times in a day and each is a real, separate event. Giving it a slot would make the
   * uniqueness constraint refuse the second legitimate dose, which is a worse defect than the one
   * S1 fixes. See `boundToSlot` in the service.
   */
  SOS: { kind: "prn" },

  /** Now, once. Exactly one slot, at the signature — never recurring. */
  STAT: { kind: "single" },
};

/** One dose the schedule says is expected. */
export interface ScheduledDose {
  /** Which line of the prescription — the ordered medication's identity. See `mar.service.ts`. */
  lineIndex: number;
  /** The instant the dose is due. */
  scheduledFor: Date;
}

/**
 * When a line is administrable.
 *
 * `stoppedAt` is separate from the duration because a cancellation is not a shorter course — it is
 * a course that ended early, and the doses already given before it remain facts (the prescription
 * model's own words on `partially_dispensed → cancelled`).
 */
export interface Course {
  /** The signature. Nothing is due before it: an unsigned prescription is not an order. */
  signedAt: Date;
  /** Cancellation / discard instant, if the order stopped early. */
  stoppedAt?: Date;
  /** Course length in clinic days, inclusive of the starting day. Absent = until stopped. */
  durationDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-03-07` + 1 → `2026-03-08`. Pure string/UTC arithmetic; no zone involved. */
function addDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** The weekday (0 = Sunday) a day key falls on. */
function weekdayOf(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/**
 * Every dose a line is due in `[from, before)`.
 *
 * **The window is required and half-open.** Not a convenience: an open-ended course (no
 * `durationDays`) has infinitely many doses, so a bounded window is the only thing that makes this
 * function terminate. The caller always knows which day it is asking about.
 *
 * @throws HMS-VAL-001 if the frequency has no policy — a value outside `DRUG_FREQUENCIES` that
 * reached the database before the enum existed. Explicit refusal, never an invented schedule: a
 * guessed dose time is a wrong dose time, and the whole point of a slot is that it is authoritative.
 */
export function dosesInRange(
  frequency: DrugFrequency,
  lineIndex: number,
  course: Course,
  zone: string,
  from: Date,
  before: Date,
): ScheduledDose[] {
  const policy = DEFAULT_ROUND_TIMES[frequency] as FrequencyPolicy | undefined;
  if (!policy) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      frequency: [`"${String(frequency)}" has no dose schedule — it cannot be charted to a slot`],
    });
  }

  if (policy.kind === "prn") return [];

  // Nothing is due before the signature or after the order stopped.
  const courseEnd = endOfCourse(course, zone);
  const start = Math.max(from.getTime(), course.signedAt.getTime());
  const end = Math.min(before.getTime(), courseEnd);
  if (start >= end) return [];

  const within = (t: number): boolean => t >= start && t < end;
  const dose = (t: number): ScheduledDose => ({ lineIndex, scheduledFor: new Date(t) });

  if (policy.kind === "single") {
    const t = course.signedAt.getTime();
    return within(t) ? [dose(t)] : [];
  }

  if (policy.kind === "interval") {
    const step = (policy.everyHours ?? 0) * 60 * 60 * 1000;
    if (step <= 0) return [];
    // Jump straight to the first dose at or after the window rather than counting up from the
    // signature — a course signed three weeks ago must not cost 500 iterations to answer "today".
    const elapsed = start - course.signedAt.getTime();
    const first = course.signedAt.getTime() + Math.max(0, Math.ceil(elapsed / step)) * step;
    const out: ScheduledDose[] = [];
    for (let t = first; t < end; t += step) out.push(dose(t));
    return out;
  }

  // clock / weekly. Walk the clinic days the window touches; a day contributes its round times.
  const times = policy.times ?? [];
  const startWeekday = weekdayOf(dayKeyInZone(course.signedAt, zone));
  const out: ScheduledDose[] = [];

  // One day either side: a wall-clock time near a boundary can land in the neighbouring UTC day.
  let dayKey = addDays(dayKeyInZone(new Date(start), zone), -1);
  const lastDay = addDays(dayKeyInZone(new Date(end), zone), 1);

  while (dayKey <= lastDay) {
    if (policy.kind !== "weekly" || weekdayOf(dayKey) === startWeekday) {
      for (const minutes of times) {
        const t = wallClockInZone(dayKey, Math.floor(minutes / 60), minutes % 60, zone).getTime();
        if (within(t)) out.push(dose(t));
      }
    }
    dayKey = addDays(dayKey, 1);
  }

  out.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  return out;
}

/**
 * The instant a course stops being administrable — the earlier of its duration running out and it
 * being cancelled.
 *
 * `durationDays` counts CLINIC days inclusive of the starting one: a 5-day course signed on
 * Monday afternoon covers Monday through Friday, ending at Saturday's local midnight. Counting
 * 5 × 24h from the signature instead would end mid-Saturday and silently offer a sixth morning
 * dose the prescriber did not order.
 */
function endOfCourse(course: Course, zone: string): number {
  const stopped = course.stoppedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (course.durationDays === undefined) return stopped;

  const startDay = dayKeyInZone(course.signedAt, zone);
  const dayAfter = addDays(startDay, course.durationDays);
  return Math.min(stopped, wallClockInZone(dayAfter, 0, 0, zone).getTime());
}

/**
 * The slot a dose charted at `administeredAt` belongs to, or `undefined` if it belongs to none.
 *
 * ── WHY THE SERVER BINDS THE SLOT RATHER THAN THE CLIENT ────────────────────
 * The client may name a slot explicitly, and most will. But a client that names nothing must not
 * therefore escape the uniqueness rule — that would leave the defect open to exactly the caller
 * most likely to be an old build. So the server resolves the nearest slot itself, and the
 * duplicate protection applies whether or not anyone asked for it.
 *
 * The tolerance is half the gap to the neighbouring dose, capped at four hours: charting at 13:00
 * against a TDS line means the 14:00 round (an hour early), not the 08:00 one (five hours late).
 * Outside any tolerance the dose binds to nothing and is recorded unconstrained — a genuine
 * back-charting of a paper round is not a slot event and must not be refused as a duplicate.
 */
export function slotFor(doses: ScheduledDose[], administeredAt: Date): ScheduledDose | undefined {
  if (doses.length === 0) return undefined;

  const t = administeredAt.getTime();
  let nearest = doses[0] as ScheduledDose;
  for (const d of doses) {
    if (Math.abs(d.scheduledFor.getTime() - t) < Math.abs(nearest.scheduledFor.getTime() - t)) {
      nearest = d;
    }
  }

  const index = doses.indexOf(nearest);
  const gaps: number[] = [];
  if (index > 0) {
    gaps.push(
      nearest.scheduledFor.getTime() - (doses[index - 1] as ScheduledDose).scheduledFor.getTime(),
    );
  }
  if (index < doses.length - 1) {
    gaps.push(
      (doses[index + 1] as ScheduledDose).scheduledFor.getTime() - nearest.scheduledFor.getTime(),
    );
  }

  const MAX_TOLERANCE = 4 * 60 * 60 * 1000;
  // A lone dose (STAT, or a single round in the window) has no neighbour to halve — it gets the cap.
  const tolerance = Math.min(MAX_TOLERANCE, gaps.length ? Math.min(...gaps) / 2 : MAX_TOLERANCE);

  return Math.abs(nearest.scheduledFor.getTime() - t) <= tolerance ? nearest : undefined;
}
