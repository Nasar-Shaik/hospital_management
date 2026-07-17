/**
 * Recognising the errors MongoDB uses to enforce our invariants.
 *
 * This codebase deliberately lets the DATABASE arbitrate the things a check cannot:
 * one doctor per slot, one message per cause. Both of those enforce with a unique
 * index, which means both must recognise a duplicate-key error and treat it as a
 * BUSINESS OUTCOME rather than a crash. That recognition belongs in one place.
 */

/** E11000 — a unique index refused the write. Not a failure; an answer. */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}
