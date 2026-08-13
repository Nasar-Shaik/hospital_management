/**
 * Saving observations when the network is not certain (M3-S4).
 *
 * ── TWO LAYERS, BECAUSE THEY FIX DIFFERENT FAILURES ─────────────────────────
 * `POST /encounters/:id/vitals` has carried `idempotent()` since it shipped. Until S4 no client
 * could use it — `ApiClient.recordVitals` sent no header — so a retry after a lost response
 * charted a SECOND reading. That is fixed at the client, and it is the strong guarantee: the same
 * key replays the original 201 and writes nothing.
 *
 * The key still does not tell the NURSE what happened. When the response is lost the phone has no
 * idea whether the observation landed, and the honest answer to "is it on the chart?" can only
 * come from the chart. So every ambiguous ending re-reads the visit's readings and looks for one
 * that was not there before — the same shape as `clinical/wardNote.ts`, for the same reason, and
 * deliberately so: a nurse and a doctor should not meet two different behaviours when the wifi
 * drops in the same corridor.
 *
 * ── WHY BOTH, WHEN EITHER SOUNDS SUFFICIENT ─────────────────────────────────
 * They fail differently. A key is scoped to one attempt from one device and expires out of the
 * store; the chart is the record and does not. Deleting the key would bring back duplicate
 * readings; deleting the reconciliation would leave the nurse guessing and re-entering, which is
 * how the duplicate arrives by a different road.
 *
 * ── WHEN IN DOUBT, SAY IT DID NOT SAVE ──────────────────────────────────────
 * If there is no reliable snapshot to compare against, this refuses to conclude anything and
 * reports `notSaved`. The two errors are not symmetric:
 *
 *   wrongly "saved"     → the nurse walks away and the observation is GONE. Unrecoverable, and
 *                         the next clinician reads a gap as "nobody has been".
 *   wrongly "not saved" → the nurse presses save again. With the key that is a REPLAY, so the
 *                         likely cost is nothing at all, and the worst case is one duplicate row.
 *
 * The cheap failure is the one to choose, every time.
 */
import { ApiClientError, type VitalsReading } from "@medicore/api-client";

export type VitalsOutcome =
  /** On the chart. `reconciled` means we learned it by re-reading, not from the response. */
  | { outcome: "saved"; reading: VitalsReading; reconciled: boolean }
  /** Confirmed or presumed absent. Pressing save again replays the same key — see the header. */
  | { outcome: "notSaved"; error: unknown }
  /** Decided before anything could be written. Report it; a retry changes nothing. */
  | { outcome: "failed"; error: unknown };

export interface VitalsWriteDeps {
  /** `POST /encounters/:id/vitals`, with the intent key. Called AT MOST ONCE per attempt. */
  record: () => Promise<VitalsReading>;
  /** `GET /encounters/:id/vitals`. The oracle, read only when the attempt was ambiguous. */
  reload: () => Promise<VitalsReading[]>;
  /**
   * The visit's readings immediately before the attempt, or `undefined` if the screen never
   * loaded them. `undefined` disables the "saved" conclusion — see the header.
   */
  before: readonly VitalsReading[] | undefined;
  /** The signed-in user. Narrows the match; `undefined` widens it, never breaks it. */
  recordedBy?: string;
}

/**
 * Errors decided BEFORE the observation could have been written, so there is nothing to reconcile.
 *
 * `HMS-VAL-001` is in this list and it is the interesting one: the server validates before the
 * insert, so a rejected value means nothing was charted — which is exactly why the screen can keep
 * the nurse's figures on screen and let them correct the flagged box.
 *
 * `HMS-REQ-002` (this key was used for a DIFFERENT body) is also definite: the earlier request
 * with this key is what exists, and the current one was refused. It is a bug if it happens, and
 * the nurse should see the refusal rather than a reconciliation that finds the earlier reading and
 * calls it this one.
 */
function isDefinitelyNotWritten(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-REQ-002"
  );
}

/** Readings present now that were not present before — by id, so nothing depends on a clock. */
export function newReadingsSince(
  before: readonly VitalsReading[],
  after: readonly VitalsReading[],
): VitalsReading[] {
  const seen = new Set(before.map((reading) => reading.id));
  return after.filter((reading) => !seen.has(reading.id));
}

/**
 * Did OUR reading land?
 *
 * ── MATCHED ON IDENTITY AND AUTHORSHIP, NEVER ON THE VALUES ─────────────────
 * A set difference on ids against a snapshot, then the author. NOT the numbers — and that is the
 * whole point of the design. Two nurses on one bay can legitimately chart the same pulse a minute
 * apart, and a colleague's identical reading claimed as ours would report a save that never
 * happened and lose the observation. A timestamp window would be worse still: it needs the phone's
 * clock to agree with the server's, which is the assumption this whole milestone refuses to make.
 *
 * When several of our readings are new — possible if an earlier attempt landed unseen — the OLDEST
 * is returned. That is the one this submission created; anything after it came later.
 */
export function matchingReading(
  before: readonly VitalsReading[],
  after: readonly VitalsReading[],
  recordedBy: string | undefined,
): VitalsReading | undefined {
  const candidates = newReadingsSince(before, after).filter(
    (reading) => recordedBy === undefined || reading.recordedBy === recordedBy,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((oldest, reading) =>
    Date.parse(reading.recordedAt) < Date.parse(oldest.recordedAt) ? reading : oldest,
  );
}

/**
 * One attempt at charting observations, with reconciliation on every ambiguous ending.
 *
 *     record
 *       ├─ 201                          → saved
 *       ├─ 401 / 403 / 400 / 404 / 409* → failed (decided before the write)   *HMS-REQ-002 only
 *       └─ anything else                → reconcile   ← every timeout, every dropped connection
 *
 *     reconcile = re-read the visit's readings
 *       ├─ a new reading of ours        → saved (reconciled)
 *       ├─ none                         → notSaved
 *       ├─ no snapshot to compare       → notSaved   ← cannot conclude, so does not
 *       └─ reload also failed           → notSaved
 */
export async function attemptVitals(deps: VitalsWriteDeps): Promise<VitalsOutcome> {
  try {
    const reading = await deps.record();
    return { outcome: "saved", reading, reconciled: false };
  } catch (error) {
    if (isDefinitelyNotWritten(error)) return { outcome: "failed", error };
    return reconcileVitals(deps, error);
  }
}

/**
 * "Did the observations actually land?" — asked of the chart.
 *
 * Exported so a screen can ask on its own: a nurse who backgrounds the app mid-save and comes back
 * must get the answer from this code path rather than from a hopeful refetch nobody classifies.
 */
export async function reconcileVitals(
  deps: VitalsWriteDeps,
  error: unknown,
): Promise<VitalsOutcome> {
  // No baseline, no conclusion. Every reading in the list would look "new", and the first one
  // this nurse charted on this visit last night would be reported as this one.
  if (deps.before === undefined) return { outcome: "notSaved", error };

  let after: VitalsReading[];
  try {
    after = await deps.reload();
  } catch {
    // The original failure is what the nurse is told about. The reload failing on top of it is our
    // problem, and reporting it would replace a useful message with a confusing one.
    return { outcome: "notSaved", error };
  }

  const found = matchingReading(deps.before, after, deps.recordedBy);
  if (found) return { outcome: "saved", reading: found, reconciled: true };
  return { outcome: "notSaved", error };
}
