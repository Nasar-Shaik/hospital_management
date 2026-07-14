/**
 * Master Patient Index — duplicate detection (DOMAIN_GLOSSARY: MPI, Doc 02 C1).
 *
 * ── THE PROBLEM, STATED HONESTLY ─────────────────────────────────────────────
 * "One patient = one UHID" is the guarantee the MPI exists to make, and it is the
 * hardest guarantee in the whole registration flow. The same person arrives as
 * "Ramesh Kumar", "R. Kumar" and "Ramesh Kumaar"; gives a different phone number
 * each time; and is not carrying ID. Meanwhile two genuinely different people
 * share a name, a birth year and a village.
 *
 * So this is not a solved problem and this file does not pretend to solve it. What
 * it does is refuse to let a probable duplicate through SILENTLY. It scores the
 * candidates, and above a threshold it stops and makes a human look.
 *
 * ── THE ASYMMETRY THAT SETS EVERY NUMBER BELOW ───────────────────────────────
 * A missed duplicate and a wrong merge are not equal-and-opposite errors:
 *
 *   missed duplicate → a second chart. Ugly, findable, and fixable later by a
 *                      merge that preserves both records.
 *   wrong merge      → one person's allergies, diagnoses and blood group on
 *                      another person's chart. It is a clinical safety incident,
 *                      and unwinding it is far harder than making it.
 *
 * Therefore: detection is aggressive (cast a wide net, show the clerk anything
 * plausible) and merging is conservative (never automatic, always a human with a
 * specific permission). We warn readily; we never merge on our own.
 *
 * ── WHY NOT PHONETIC / FUZZY MATCHING ────────────────────────────────────────
 * Soundex and Metaphone are tuned for English surnames and behave badly on Indian
 * names — the false-positive rate is exactly the direction we just said is the
 * dangerous one. Levenshtein on full names is worse: it rates "Sana" and "Sonu" a
 * single edit apart. Deterministic keys are less clever and much safer. When this
 * needs to improve, the upgrade is a probabilistic matcher with a REVIEW QUEUE
 * (an MRD clerk resolving flagged pairs), not a smarter guess made silently at
 * the front desk.
 */
import type { Patient } from "./patient.repository.js";
import { nameKeyOf } from "./patient.model.js";

/**
 * Weights. They sum such that no SINGLE attribute can trip the threshold on its
 * own — that is the point of the design, not an accident of tuning.
 *
 * A shared phone is the strongest signal we have, but it is not proof: a family
 * shares one mobile, and a whole village shares the number of the man who owns a
 * phone. So phone alone (40) sits below the threshold (60); it must be corroborated
 * by a name or a date of birth. Likewise an identical name alone (35) is a
 * coincidence in any hospital with ten thousand patients.
 */
const WEIGHT = {
  phone: 40,
  name: 35,
  dob: 20,
  gender: 5,
} as const;

/**
 * At or above this, registration STOPS and asks a human (HMS-PAT-002). Below it,
 * candidates are still returned so the UI can show them — a clerk who sees a near
 * match and recognizes the patient will pick it, and that quiet path prevents more
 * duplicates than the hard block does.
 */
export const DUPLICATE_THRESHOLD = 60;

export interface DuplicateCandidate {
  patient: Patient;
  score: number;
  /** Human-readable, and it goes on the screen — a score with no reason is not reviewable. */
  matchedOn: string[];
}

export interface MatchCriteria {
  name: string;
  gender?: string;
  dob?: Date;
  phone?: string;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Scores one candidate against the person standing at the desk. */
export function score(criteria: MatchCriteria, candidate: Patient): DuplicateCandidate {
  const matchedOn: string[] = [];
  let total = 0;

  if (criteria.phone && candidate.contact.phone && criteria.phone === candidate.contact.phone) {
    total += WEIGHT.phone;
    matchedOn.push("phone");
  }

  if (nameKeyOf(criteria.name) === nameKeyOf(candidate.name)) {
    total += WEIGHT.name;
    matchedOn.push("name");
  }

  if (criteria.dob && candidate.dob && sameDay(criteria.dob, candidate.dob)) {
    total += WEIGHT.dob;
    matchedOn.push("date of birth");
  }

  /**
   * Gender only ever CORROBORATES; it is never a match on its own, and a mismatch
   * is deliberately not a penalty. Registration data is wrong all the time —
   * someone tabbed past the field, or the patient's gender is recorded
   * inconsistently across visits — and subtracting points for it would suppress
   * exactly the duplicate we want a human to look at.
   */
  if (
    criteria.gender &&
    criteria.gender !== "unknown" &&
    candidate.gender !== "unknown" &&
    criteria.gender === candidate.gender &&
    matchedOn.length > 0
  ) {
    total += WEIGHT.gender;
    matchedOn.push("gender");
  }

  return { patient: candidate, score: total, matchedOn };
}

/** Scores every candidate and returns them worst-first for a human to review. */
export function rank(criteria: MatchCriteria, candidates: Patient[]): DuplicateCandidate[] {
  return candidates
    .map((candidate) => score(criteria, candidate))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** True when at least one candidate is close enough to stop and ask. */
export function isProbableDuplicate(ranked: DuplicateCandidate[]): boolean {
  return ranked.some((c) => c.score >= DUPLICATE_THRESHOLD);
}
