/**
 * Preconditions a patient merge must clear before it changes anything.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT AN IMPORT ────────────────────────────
 * `encounters` carries a unique partial index — "a patient has at most one open encounter"
 * (`clinicalInvariants.ts`, `one_open_encounter_per_patient`). Merging two records that BOTH have
 * a visit open asks that index for the one thing it exists to refuse, and it answers E11000.
 *
 * That would be survivable if it failed cleanly. It does not. The merge fan-out runs its consumers
 * under `Promise.allSettled`, so by the time encounters throws, the bills, the notes, the doses and
 * the coding have already moved and the patient is already marked `merged`. The job then retries
 * into the same collision forever, and the survivor is left holding everything except the visit
 * history, with nothing on any screen to say so.
 *
 * So it has to be caught BEFORE the first write. The obvious way — have `patient.service.ts` ask
 * the encounters module — is not available: `encounters` already imports `patients` for identity
 * (`getPatient`, `namesByIds`, the server-side name and UHID that closed D18), and the reverse edge
 * would close a cycle the boundary rule correctly refuses.
 *
 * So the dependency is inverted, exactly as the merge fan-out already inverts the other direction:
 *
 *     after a merge   →  a module REACTS      →  core/events/patientMerge.ts
 *     before a merge  →  a module may OBJECT  →  here
 *
 * `patients` calls `assertMergeAllowed` and knows nothing about who answers. `encounters` supplies
 * the rule and knows nothing about merging. Both depend on core; core depends on neither.
 *
 * ── THIS IS NOT A RECONCILIATION ENGINE, AND MUST NOT BECOME ONE ────────────
 * A guard may only REFUSE. It may not close an encounter, pick a winner, or edit clinical content
 * to make a merge possible — deciding which of two open visits is the real one is a clinical
 * judgement, and a merge that quietly ended somebody's visit would be the software making it to
 * save a clerk a click. The MPI's whole design is to stop and ask a human; this stops one step
 * earlier and asks the same human.
 */
import type { AppError } from "../errors/appError.js";

/**
 * Throws to refuse the merge; returns to allow it. The thrown error reaches the caller unchanged,
 * so the module that objects owns the error code and the wording — the guard registry never
 * invents a message about a domain it does not understand.
 */
export type MergeGuard = (survivorId: string, duplicateId: string) => Promise<void>;

const guards = new Map<string, MergeGuard>();

/**
 * Registered at the composition root (`app.ts`), never by import side effect.
 *
 * Keyed by name and idempotent, because the app is constructed more than once in a test run and a
 * list would grow a duplicate guard per `createApp`. Re-registering the same name replaces it.
 */
export function registerMergeGuard(name: string, guard: MergeGuard): void {
  guards.set(name, guard);
}

/** The names currently registered — read by the test that proves a guard is wired to something. */
export function registeredMergeGuards(): string[] {
  return [...guards.keys()].sort();
}

/** Test seam. Production never calls this; `createApp` re-registers on every construction. */
export function clearMergeGuards(): void {
  guards.clear();
}

/**
 * Runs every precondition. Sequential rather than `Promise.all`: the first refusal is the one the
 * clerk should read, and running the rest afterwards would only risk a second error racing it into
 * the response.
 */
export async function assertMergeAllowed(survivorId: string, duplicateId: string): Promise<void> {
  for (const guard of guards.values()) {
    await guard(survivorId, duplicateId);
  }
}

/** Re-exported so a guard's module can type its throw without reaching into core's error paths. */
export type { AppError };
