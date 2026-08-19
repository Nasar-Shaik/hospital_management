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

/**
 * Runs an UPSERT that a unique index also guards, retrying once if the index refuses it.
 *
 * ── THE RACE THIS EXISTS FOR, AND WHY IT IS NOT A TEST FLAKE ────────────────
 * `findOneAndUpdate(filter, update, { upsert: true })` is two steps inside the server: find, then
 * insert if nothing matched. Two callers arriving together can BOTH find nothing and BOTH attempt
 * the insert, and the unique index then refuses the second with E11000. MongoDB documents this and
 * says to retry — on the second attempt the document exists, the filter matches, and the upsert
 * becomes an ordinary update.
 *
 * Without the retry the loser's error escapes the repository and the error handler answers
 * `HMS-GEN-500`. That is the wrong answer twice over: nothing went wrong (the row the caller wanted
 * is right there), and a 500 is the one status a client is entitled to treat as "the server is
 * broken, stop".
 *
 * ── WHY A RETRY AND NOT A 409 ───────────────────────────────────────────────
 * Because these upserts mean "make this row say this". A second nurse triaging the same patient is
 * not a conflict to refuse — it is a revision, and the second one is the current judgement. An
 * upsert whose losing caller should be REFUSED is not an upsert; it is an insert, and
 * `isDuplicateKey` at the call site is the right tool for that (see `theatre.service.ts`).
 *
 * ── ONCE, NOT IN A LOOP ─────────────────────────────────────────────────────
 * The second attempt cannot hit the same race: the document it lost to now exists, so the filter
 * matches and no insert is attempted. A second E11000 would mean the filter and the unique key
 * disagree — a modelling error that must surface, not be retried around.
 */
export async function upsertRetryingOnDuplicate<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    return attempt();
  }
}
