/**
 * Writing a ward note against an endpoint with NO idempotency and NO state guard.
 *
 * ── THIS IS THE WEAKEST WRITE IN THE APP, AND IT IS WORTH BEING EXACT ───────
 * `POST /encounters/:id/notes` has no `idempotent()` middleware (its sibling `admit` does) and the
 * ward-note repository has no de-duplication. A retry after a lost response therefore creates a
 * SECOND note. Nothing server-side prevents it.
 *
 * That is milder than a second order — nobody is stuck twice — but it is not nothing: a ward note
 * is an immutable medico-legal record with no update path and no delete path, so a duplicate is
 * permanent, and a chart with two identical 09:40 entries reads as though the patient was reviewed
 * twice. It also makes every later reader wonder which one is real.
 *
 * ── SO THE PHONE ASKS THE CHART, AND IT ASKS EXACTLY ────────────────────────
 * After an ambiguous failure, re-read the notes and look for a note that WAS NOT THERE BEFORE and
 * matches what we tried to write. The comparison is a set difference on note ids against a
 * snapshot taken before the attempt — not a timestamp window. A window would need the phone's
 * clock to agree with the server's `at`, and it would also mistake yesterday's identical
 * "Reviewed. Stable. Continue same." — which is a sentence a real doctor writes every morning —
 * for today's.
 *
 * ── WHEN IN DOUBT, SAY IT DID NOT SAVE ──────────────────────────────────────
 * If there is no reliable snapshot, reconciliation refuses to conclude anything and reports
 * `notSaved`. The two errors are not symmetric:
 *
 *   wrongly "saved"     → the doctor walks away and the note is GONE. Unrecoverable.
 *   wrongly "not saved" → the doctor presses save again and the chart gets a duplicate. Visible,
 *                         and a duplicate note has never hurt a patient.
 *
 * The cheap failure is the one to choose, every time.
 *
 * ── THE CLEAN FIX IS A BACKEND ONE, AND IT IS NOT MADE HERE ─────────────────
 * Mounting `idempotent()` on the notes route would make this exact rather than careful: one line,
 * backward compatible (the header is optional), and identical to what `admit` already does. It is
 * NOT required — this module is sufficient without it — so under the existing-backend-first rule it
 * is reported rather than done.
 */
import { ApiClientError, type WardNote } from "@medicore/api-client";

export type WardNoteOutcome =
  /** On the chart. `reconciled` means we learned it by re-reading, not from the response. */
  | { outcome: "saved"; note: WardNote; reconciled: boolean }
  /** Confirmed or presumed absent. Pressing save again is safe — at worst it duplicates. */
  | { outcome: "notSaved"; error: unknown }
  /** Something pressing save again will not fix. Report it; do not offer a retry. */
  | { outcome: "failed"; error: unknown };

export interface WardNoteDeps {
  /** `POST /encounters/:id/notes`. Called AT MOST ONCE per attempt. */
  add: (text: string) => Promise<WardNote>;
  /** `GET /encounters/:id/notes`. The oracle, read only when the attempt was ambiguous. */
  reload: () => Promise<WardNote[]>;
  /**
   * The notes as they were immediately before the attempt, or `undefined` if the screen never
   * loaded them. `undefined` disables the "saved" conclusion — see the header.
   */
  before: readonly WardNote[] | undefined;
  /** The signed-in user. Narrows the match; `undefined` simply widens it, never breaks it. */
  authorId?: string;
}

/**
 * Errors decided BEFORE the note could have been written, so there is nothing to reconcile.
 *
 * `HMS-STATE-001` is deliberately NOT in this list even though it is usually "the patient is
 * already discharged". It is also what an OP encounter returns, and the difference matters: the
 * note may have landed on the last request and the stay been closed by somebody else in between.
 * Re-reading answers that; assuming does not.
 */
function isDefinitelyNotWritten(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-PLAN-002"
  );
}

/** Notes present now that were not present before — by id, so nothing depends on a clock. */
export function newNotesSince(before: readonly WardNote[], after: readonly WardNote[]): WardNote[] {
  const seen = new Set(before.map((note) => note.id));
  return after.filter((note) => !seen.has(note.id));
}

/**
 * Did OUR note land? A new `progress` note, our text, our authorship.
 *
 * All three conditions are required. Text alone would match a colleague writing the same line at
 * the same moment on the ward computer, and claiming their note as ours would lose the doctor's.
 */
export function matchingNote(
  before: readonly WardNote[],
  after: readonly WardNote[],
  text: string,
  authorId: string | undefined,
): WardNote | undefined {
  const wanted = text.trim();
  return newNotesSince(before, after).find(
    (note) =>
      note.type === "progress" &&
      note.text.trim() === wanted &&
      (authorId === undefined || note.authorId === authorId),
  );
}

/**
 * One attempt at a ward note, with reconciliation on every ambiguous ending.
 *
 *     add
 *       ├─ 201                      → saved
 *       ├─ 401 / 403 / 400 / 404    → failed (decided before the write)
 *       ├─ HMS-PLAN-002             → failed (no ward module; nothing was written)
 *       └─ anything else            → reconcile   ← including HMS-STATE-001 and every timeout
 *
 *     reconcile = reload the notes
 *       ├─ a new matching note      → saved (reconciled)
 *       ├─ no new matching note     → notSaved
 *       ├─ no snapshot to compare   → notSaved   ← cannot conclude, so does not
 *       └─ reload also failed       → notSaved
 */
export async function attemptWardNote(deps: WardNoteDeps, text: string): Promise<WardNoteOutcome> {
  try {
    const note = await deps.add(text);
    return { outcome: "saved", note, reconciled: false };
  } catch (error) {
    if (isDefinitelyNotWritten(error)) return { outcome: "failed", error };
    return reconcileWardNote(deps, text, error);
  }
}

/**
 * "Did the note actually land?" — asked of the chart.
 *
 * Exported so a screen can ask on its own: a doctor who backgrounds the app mid-save and comes back
 * must get the answer from this code path rather than from a hopeful refetch nobody classifies.
 */
export async function reconcileWardNote(
  deps: WardNoteDeps,
  text: string,
  error: unknown,
): Promise<WardNoteOutcome> {
  // No baseline, no conclusion. Every note in the list would look "new", and the first identical
  // note from any previous day would be reported as this one.
  if (deps.before === undefined) return { outcome: "notSaved", error };

  let after: WardNote[];
  try {
    after = await deps.reload();
  } catch {
    // The original failure is what the doctor is told about. The reload failing on top of it is
    // our problem, and reporting it would replace a useful message with a confusing one.
    return { outcome: "notSaved", error };
  }

  const found = matchingNote(deps.before, after, text, deps.authorId);
  if (found) return { outcome: "saved", note: found, reconciled: true };
  return { outcome: "notSaved", error };
}
