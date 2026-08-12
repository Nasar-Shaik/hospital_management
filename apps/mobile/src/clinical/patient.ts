/**
 * Patient identity, as it must appear at the top of every clinical screen.
 *
 * ── IDENTITY IS A SAFETY CONTROL, NOT A HEADING ─────────────────────────────
 * Every wrong-patient error starts with someone reading the right record for the wrong person. The
 * identity line is therefore fixed: NAME, then UHID — the number on the wristband, which is the
 * only thing in the record a nurse can physically check against the patient in front of her — then
 * age and sex. Never name alone; two Rajesh Kumars in one ward is not a hypothetical.
 */
import type { Gender, Patient } from "@medicore/api-client";

const GENDER_SHORT: Record<Gender, string> = {
  male: "M",
  female: "F",
  other: "O",
  unknown: "—",
};

/**
 * Whole years, from `dob` (`YYYY-MM-DD`) to now.
 *
 * ── COMPARED AS CALENDAR PARTS, NOT AS MILLISECONDS ─────────────────────────
 * `(now - dob) / 365.25 days` is wrong by a day around a birthday and wrong by an hour's worth of
 * rounding at every timezone boundary. Age is a calendar fact: subtract the years, then take one
 * back if this year's birthday has not arrived. `dob` is a plain date with no zone, so it is read
 * as its parts rather than parsed into an instant that would shift under `Date`'s local-time rules.
 *
 * Returns `undefined` rather than 0 for a missing or malformed date: "0 y" on a chart reads as a
 * newborn, which is a clinically dangerous thing to print about an adult.
 */
export function ageInYears(dob: string | undefined, now: Date = new Date()): number | undefined {
  if (!dob) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];

  let age = now.getFullYear() - year;
  const monthNow = now.getMonth() + 1;
  const dayNow = now.getDate();
  if (monthNow < month || (monthNow === month && dayNow < day)) age -= 1;

  return age >= 0 && age < 150 ? age : undefined;
}

/** `34 y · F` — the demographic half of the identity line. Omits what the record does not know. */
export function demographics(
  patient: Pick<Patient, "gender" | "dob">,
  now: Date = new Date(),
): string {
  const age = ageInYears(patient.dob, now);
  const parts: string[] = [];
  if (age !== undefined) parts.push(`${String(age)} y`);
  parts.push(GENDER_SHORT[patient.gender]);
  return parts.join(" · ");
}

/**
 * True when this record is no longer the live chart — it was merged INTO another (MPI).
 *
 * Worth its own predicate because a merged record still reads perfectly: it has a name, a UHID and
 * a history, and nothing about it looks stale. Writing against it would put a note on a chart
 * nobody opens again.
 */
export function isSupersededRecord(patient: Pick<Patient, "status" | "mergedInto">): boolean {
  return patient.status === "merged" || patient.mergedInto !== undefined;
}
