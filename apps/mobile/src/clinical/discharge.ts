/**
 * Ending a stay, safely — the same shape as `clinical/signing.ts`, for the same reason.
 *
 * ── ONE ACT, TWO RECORDS, AND NO IDEMPOTENCY KEY ────────────────────────────
 * `POST /encounters/:id/discharge` writes the discharge summary AND closes the encounter. It has no
 * idempotency middleware. What it has instead is two guards that make a second attempt refuse
 * rather than repeat:
 *
 *   `requireOpenAdmission`   → the stay is already over          → HMS-STATE-001
 *   `findDischargeSummary`   → this admission already has one    → HMS-STATE-001
 *
 * So, exactly as with signing, **the hazard is a false error, not a double discharge.** The patient
 * cannot be discharged twice and cannot get two summaries. What can happen is that the response is
 * lost on ward wifi, the doctor sees a failure for something that worked, presses again, and is
 * told "invalid state transition" for a patient who is already on their way home — while the bed
 * still shows occupied on their screen.
 *
 * ── `dischargedAt` IS THE ORACLE ────────────────────────────────────────────
 * `dischargePatient` sets `status: "closed"`, `dischargedAt` and `disposition` inside ONE
 * transaction, so the three cannot disagree. `dischargedAt` is read first because it is specific to
 * a stay ENDING: `status === "closed"` is also how an OP visit finishes, and a predicate that
 * conflated them would report an outpatient consultation as a discharge.
 *
 * ── THE THIRD OUTCOME NOBODY EXPECTS: A TORN DISCHARGE ──────────────────────
 * The summary is written and THEN the stay is closed, deliberately and not in one transaction —
 * the service's own comment explains why that order is the safe one. It leaves a window: if the
 * close fails after the summary is written, the admission has a summary and is still open. A retry
 * then hits the summary guard and is refused FOREVER, so telling the doctor to "try again" would be
 * telling them to do something that cannot work.
 *
 * That state is rare (it needs a server-side failure between two awaits — a client timeout does not
 * cause it, because the server carries on) and it is a pre-existing backend hazard, not one this
 * app introduces. What this module can do is NAME it: `incomplete` is reported as its own outcome,
 * with no retry offered, so the ward escalates instead of tapping.
 */
import { ApiClientError, type Encounter, type WardNote } from "@medicore/api-client";

/** What `POST /encounters/:id/discharge` takes. Exactly its fields — nothing invented. */
export interface DischargeInput {
  /** The body of the summary: what was found, what was done. Required by the server. */
  text: string;
  diagnosis?: string;
  advice?: string;
  /** `YYYY-MM-DD`. Built with `formatDayKey` in the BRANCH's zone, never the device's. */
  followUpOn?: string;
}

export type DischargeOutcome =
  /** The stay is over. `reconciled` means we learned it by re-reading, not from the response. */
  | { outcome: "discharged"; encounterId: string; reconciled: boolean }
  /** Summary written, stay still open — see the header. NOT retryable; needs a human. */
  | { outcome: "incomplete"; error: unknown }
  /** Confirmed or presumed not discharged. Pressing discharge again is safe. */
  | { outcome: "notDischarged"; error: unknown }
  /** Something pressing discharge again will not fix. Report it; offer no retry. */
  | { outcome: "failed"; error: unknown };

export interface DischargeDeps {
  /** `POST /encounters/:id/discharge`. Called AT MOST ONCE per attempt. */
  discharge: (input: DischargeInput) => Promise<{ encounterId: string }>;
  /** `GET /encounters/:id`. The oracle. */
  reload: () => Promise<Encounter>;
  /** `GET /encounters/:id/notes`. Only consulted to tell `incomplete` from `notDischarged`. */
  notes: () => Promise<WardNote[]>;
}

/** Has this stay ended, however it ended? See the header for why `dischargedAt` comes first. */
export function isStayEnded(
  encounter: Pick<Encounter, "class" | "status" | "dischargedAt">,
): boolean {
  if (encounter.dischargedAt) return true;
  return encounter.class === "IP" && encounter.status === "closed";
}

/** Errors decided before the transaction opened — nothing can have changed. */
function isDefinitelyNotDischarged(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404" ||
    error.code === "HMS-PLAN-002"
  );
}

/**
 * One discharge attempt, with reconciliation on every ambiguous ending.
 *
 *     discharge
 *       ├─ 201                      → discharged
 *       ├─ 401 / 403 / 400 / 404    → failed (decided before the write)
 *       ├─ HMS-PLAN-002             → failed (no ward module at all)
 *       ├─ HMS-STATE-001            → reconcile   ← usually "it already worked"
 *       ├─ timeout / dropped wire   → reconcile
 *       └─ anything else            → reconcile   ← the safe default
 *
 *     reconcile = reload the encounter
 *       ├─ dischargedAt set         → discharged (reconciled)
 *       ├─ still open, summary      → incomplete      ← retrying can never succeed
 *       ├─ still open, no summary   → notDischarged   ← retry is safe
 *       └─ reload failed            → notDischarged   ← retry is safe: the guards refuse a repeat
 */
export async function attemptDischarge(
  deps: DischargeDeps,
  input: DischargeInput,
): Promise<DischargeOutcome> {
  try {
    const result = await deps.discharge(input);
    return { outcome: "discharged", encounterId: result.encounterId, reconciled: false };
  } catch (error) {
    if (isDefinitelyNotDischarged(error)) return { outcome: "failed", error };
    return reconcileDischarge(deps, error);
  }
}

/**
 * "Did the discharge actually happen?" — asked of the encounter, then of its notes.
 *
 * The second question is only asked when the first says no, and only to separate "it did not
 * happen, press again" from "it half happened, do not press again". Two different sentences, and
 * offering the wrong one either loses a discharge or sends a doctor into a loop.
 */
export async function reconcileDischarge(
  deps: DischargeDeps,
  error: unknown,
): Promise<DischargeOutcome> {
  let current: Encounter;
  try {
    current = await deps.reload();
  } catch {
    return { outcome: "notDischarged", error };
  }

  if (isStayEnded(current)) {
    return { outcome: "discharged", encounterId: current.id, reconciled: true };
  }

  let notes: WardNote[];
  try {
    notes = await deps.notes();
  } catch {
    // We know the stay is open and cannot tell why the write failed. "Not discharged" is the
    // honest answer, and a retry either succeeds or reports the summary guard next time round.
    return { outcome: "notDischarged", error };
  }

  if (notes.some((note) => note.type === "discharge_summary")) {
    return { outcome: "incomplete", error };
  }
  return { outcome: "notDischarged", error };
}
