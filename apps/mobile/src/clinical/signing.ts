/**
 * Signing a prescription, safely, against an operation that is NOT idempotent.
 *
 * ── THE HAZARD IS A FALSE ERROR, NOT A DOUBLE SIGNATURE ─────────────────────
 * `POST /prescriptions/:id/sign` has no idempotency key, and it is worth being precise about what
 * that does and does not put at risk.
 *
 * It CANNOT produce two signatures. The transition table (`prescription.model.ts`) allows
 * `draft → signed` and nothing else into `signed`, so a second attempt on an already-signed
 * prescription is refused with `HMS-STATE-001` before it reaches the record. The server's own
 * strictness is what makes a retry harmless.
 *
 * What it CAN produce is a lie. The response to a successful signature is lost — the phone drops
 * off the ward wifi in the second between the write committing and the reply arriving — and the
 * doctor sees a failure for something that worked. They press again; now they get
 * `HMS-STATE-001`, "invalid state transition", which reads as a bug. The prescription is signed,
 * the pharmacy already has it, and the only person who does not know is the prescriber.
 *
 * ── SO EVERY AMBIGUOUS ENDING GOES THROUGH ONE RECONCILIATION ───────────────
 * There is exactly one question worth asking after a failed attempt — "is it signed?" — and
 * exactly one place that can answer it: the record itself. `signedAt` is the oracle. It is set by
 * the signature and never cleared, and it survives every state that comes after (`dispensed`,
 * `partially_dispensed`, and even `cancelled` — a stopped prescription was still signed). Reading
 * `status === "signed"` instead would report a dispensed prescription as unsigned and invite a
 * doctor to sign it a second time.
 *
 * ── THIS FUNCTION SIGNS AT MOST ONCE ────────────────────────────────────────
 * Reconciliation READS. It never calls `sign` again — not on `HMS-STATE-001`, not on a timeout,
 * not on anything. A retry is offered to the doctor as a button; it is never taken automatically.
 * `shouldRetryMutation` (`net/retry.ts`) says the same thing one layer down, and both are
 * deliberate: an automatic retry of a clinical write is a decision no transport should make.
 *
 * ── THE EXISTING CONTRACT IS SUFFICIENT, AND THAT WAS CHECKED ───────────────
 * No API change was needed for any of this. `GET /prescriptions/:id` returns `signedAt`,
 * `signedBy` and `status`; `HMS-STATE-001` carries `from` in its details. Between them the phone
 * can always tell "it worked and I did not hear" from "it did not work".
 */
import { ApiClientError, type Prescription, type SafetyAlert } from "@medicore/api-client";

/**
 * Has this prescription been signed — ever?
 *
 * `signedAt`, not `status`. A signed prescription moves on to `partially_dispensed`, `dispensed`
 * or `cancelled`, and in every one of those the signature happened. Asking about `status` would
 * answer "no" for a prescription whose drugs are already in the patient.
 */
export function isSigned(prescription: Pick<Prescription, "signedAt">): boolean {
  return prescription.signedAt !== undefined && prescription.signedAt !== null;
}

/** A signed prescription is immutable — `amend` supersedes it, nothing edits it (§6). */
export function isEditable(prescription: Pick<Prescription, "status" | "signedAt">): boolean {
  return prescription.status === "draft" && !isSigned(prescription);
}

export type SignOutcome =
  /** Signed. `reconciled` means we learned it by re-reading, not from the sign response. */
  | { outcome: "signed"; prescription: Prescription; reconciled: boolean }
  /** A contraindication. Signing needs an explicit override reason from the prescriber. */
  | { outcome: "blocked"; alerts: SafetyAlert[]; error: ApiClientError }
  /** Confirmed or presumed unsigned. The doctor may press Sign again — safely. */
  | { outcome: "unsigned"; error: unknown }
  /** Something that pressing Sign again will not fix. Report it; do not offer a retry. */
  | { outcome: "failed"; error: unknown };

export interface SignDeps {
  /** `POST /prescriptions/:id/sign`. Called AT MOST ONCE per `attemptSign`. */
  sign: (overrideReason?: string) => Promise<Prescription>;
  /** `GET /prescriptions/:id`. The oracle. Called only when the attempt was ambiguous. */
  reload: () => Promise<Prescription>;
}

/** `HMS-RX-001` carries the alerts the prescriber must acknowledge. Parsed defensively. */
function alertsFrom(error: ApiClientError): SafetyAlert[] {
  const details = error.details as { alerts?: unknown } | undefined;
  return Array.isArray(details?.alerts) ? (details.alerts as SafetyAlert[]) : [];
}

/**
 * Errors that mean "this attempt was refused before anything happened", so the record cannot have
 * changed and there is nothing to reconcile.
 *
 * `HMS-AUTH-005` (not your permission), `HMS-VAL-001` (no drugs on it), `HMS-PLAN-002` (not in the
 * edition) and the auth codes are all decided before the transaction. Re-reading after one of
 * these would be a wasted round trip and, worse, would make the code look as though a permission
 * failure might have signed something.
 */
function isDefinitelyNotSigned(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.isUnauthenticated ||
    error.isForbidden ||
    error.code === "HMS-VAL-001" ||
    error.code === "HMS-GEN-404"
  );
}

/**
 * One signing attempt, with reconciliation on every ambiguous ending.
 *
 *     sign
 *       ├─ 200                      → signed
 *       ├─ HMS-RX-001               → blocked (needs an override reason)
 *       ├─ HMS-STATE-001            → reconcile
 *       ├─ network failure/timeout  → reconcile
 *       ├─ 403 / 401 / 400 / 404    → failed (decided before the write; nothing to reconcile)
 *       └─ anything else            → reconcile   ← the safe default
 *
 *     reconcile = reload
 *       ├─ signedAt present         → signed (reconciled)
 *       ├─ still a draft            → unsigned, retry is safe
 *       └─ reload also failed       → unsigned, retry is safe
 *
 * The last reconcile branch is the interesting one. We do not know whether the signature landed,
 * and we say "unsigned" anyway — because the only action it enables is pressing Sign again, and
 * the state machine guarantees that a second attempt on a signed prescription is refused rather
 * than duplicated. The worst case is one wasted request and another trip through this function.
 */
export async function attemptSign(deps: SignDeps, overrideReason?: string): Promise<SignOutcome> {
  try {
    const prescription = await deps.sign(overrideReason);
    return { outcome: "signed", prescription, reconciled: false };
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "HMS-RX-001") {
      return { outcome: "blocked", alerts: alertsFrom(error), error };
    }
    if (isDefinitelyNotSigned(error)) {
      return { outcome: "failed", error };
    }
    return reconcile(deps, error);
  }
}

/**
 * "Did it actually happen?" — asked of the record, after an attempt we could not interpret.
 *
 * Exported so a screen can ask it on its own: a doctor who backgrounds the app mid-signature and
 * returns needs the same answer, and must get it from the same code path rather than from a
 * hopeful `refetch` whose result nobody classifies.
 */
export async function reconcile(deps: SignDeps, error: unknown): Promise<SignOutcome> {
  let current: Prescription;
  try {
    current = await deps.reload();
  } catch {
    // The original failure is what the user is told about — the reload failing on top of it is
    // our problem, not theirs, and reporting it would replace a useful message with a confusing one.
    return { outcome: "unsigned", error };
  }

  if (isSigned(current)) return { outcome: "signed", prescription: current, reconciled: true };
  return { outcome: "unsigned", error };
}
