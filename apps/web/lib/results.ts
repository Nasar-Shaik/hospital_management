/**
 * When a doctor may read a result — the ONE place the web app decides it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The rule was written three times and came out three different ways.
 *
 *   · The consultation screen (`my-patients`) gated the result on `released`, with a comment
 *     citing STATE_MACHINE_CATALOG §15: "A number that has been run but not signed off must not
 *     reach the person who will act on it."
 *   · The patient chart (`patients/[id]`) rendered `result.summary` at ANY status — so the same
 *     doctor, reading the same order on a different screen, saw an unverified number.
 *   · Mobile (`clinical/results.ts`) gated on `released`, and its header asserted "The web app
 *     enforces exactly this" — true of one of the two web screens.
 *
 * Three surfaces, one clinical rule, and the only thing keeping them in step was that somebody
 * remembered. A rule that has to be remembered in three places is a rule that is already wrong in
 * one of them.
 *
 * ── THE LADDER, AND WHY IT HAS THREE RUNGS ──────────────────────────────────
 * `completed` means a machine produced a number. `verified` means a second, qualified person
 * checked it — the technician who ran the test cannot be the one who certifies it. `released`
 * means it may reach the person who will act on it, which is a DISCLOSURE decision and not the
 * same as the clinical one: an HIV result is given with counselling, not by a portal at 2am.
 *
 * So the gate is `released`, and it is deliberately not `verified`.
 */
import type { Order, OrderRow } from "@medicore/api-client";

/** Everything either doctor-facing screen needs to decide what to show. */
type Readable = Pick<Order | OrderRow, "status" | "result">;

/**
 * True once a clinician may read the numbers. The single gate; every doctor-facing surface asks
 * it, and the name matches mobile's `isResultReadable` so the two are recognisably one rule.
 */
export function isResultReadable(order: Readable): boolean {
  return order.status === "released" && order.result !== undefined;
}

/**
 * True when the lab flagged a critical value that has NOT been released yet.
 *
 * ── WHY THIS IS SHOWN AT ALL, WHEN THE NUMBER IS NOT ────────────────────────
 * Because the hospital has already told the doctor. `order.service.ts` raises the critical alert
 * SYNCHRONOUSLY at completion — before verification, long before release — and the
 * `order.critical` template carries the value with the sentence "This value has NOT yet been
 * verified by a pathologist. It is being sent to you immediately because waiting for verification
 * could cost more than it is worth."
 *
 * Having sent that email, showing nothing on the chart would be the incoherent choice: the doctor
 * who opens the record after reading the alert would find a row that looks ordinary.
 *
 * ── AND WHY IT MUST NEVER BE A BARE RED BADGE ───────────────────────────────
 * Mobile refuses to show any critical marker before release, and its reason is a good one:
 * an unqualified red pill "would push a clinician to act on a number nobody has confirmed — while
 * also making it impossible to tell, at a glance, which reds are real."
 *
 * That objection is about the LABEL, not the disclosure. So the web surfaces show it with the
 * words — never a red pill on its own — which is the same bargain the email already makes. Callers
 * are expected to render `CRITICAL_PENDING_LABEL` alongside; the `awaitingRelease` helper below is
 * what they use for the ordinary case, and neither ever hands over `result.summary`.
 */
export function isCriticalPending(order: Readable): boolean {
  return order.result?.critical === true && order.status !== "released";
}

/** The words that must accompany an early critical marker. Never shown without them. */
export const CRITICAL_PENDING_LABEL = "CRITICAL — not yet verified";

/**
 * What to say in the result column when there is no readable result: what the doctor is WAITING
 * FOR, phrased from their side rather than the laboratory's.
 *
 * "Completed" on a doctor's screen reads as "there is a number for me", and there is not one yet —
 * this is the wording that stops somebody chasing a result that has not landed, and it is the same
 * distinction mobile's `orderStatusLabel` draws. `null` when the row has an ending of its own
 * (released, cancelled) and the caller should render that instead.
 */
export function awaitingRelease(order: Readable): string | null {
  switch (order.status) {
    case "placed":
    case "accepted":
      return "Not started";
    case "in_progress":
      return "Being run";
    case "completed":
      return "Awaiting verification";
    case "verified":
      return "Awaiting release";
    default:
      return null;
  }
}
