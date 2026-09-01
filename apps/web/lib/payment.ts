/**
 * Whether the laboratory holds a test for payment — the web app's policy, in one place.
 *
 * ── THIS IS A WEB POLICY, NOT A SYSTEM INVARIANT ────────────────────────────
 * The API gates nothing on payment: `order.service.ts` walks the whole state machine with no
 * payment check and there is no `paid` field on an order. That is deliberate — a hard server gate
 * refuses a stat troponin over an unfinalized bill, and a zero-tariff government hospital could
 * never run a test at all. See `AI_Workflow/docs/PAYMENT_POLICY.md`.
 *
 * So this rule lives here, in the browser, and it is extracted from the worklist's JSX for two
 * reasons: it can be tested without mounting a page, and a policy written inline is a policy that
 * gets a second, slightly different copy the first time another screen needs it.
 */
import type { OrderStatus } from "@medicore/api-client";

/** What `GET /billing/order-payments` answers per order. */
export type PaymentState = "paid" | "unpaid" | "unbilled" | "free";

/** The statuses at which work has not yet been done, and a hold therefore still means something. */
const HOLDABLE: readonly OrderStatus[] = ["placed", "accepted", "in_progress"];

/**
 * True when the worklist should withhold the action buttons and say "Awaiting payment".
 *
 * Only a real, raised, unpaid charge holds work:
 *
 *   · `free`     — a zero-tariff government patient. Never shown as unpaid and never turned away;
 *                  holding these would make the product unusable for a whole customer segment.
 *   · `unbilled` — no charge has posted yet (the `order.placed` event may still be in flight).
 *                  Holding on "we have not billed you" would hold every test for a few seconds and
 *                  some forever.
 *   · `undefined`— the lookup has not answered. Absence of data is not evidence of non-payment.
 *
 * Past `in_progress` the sample has been run: holding a `completed` result hides work already
 * done, which is a different and worse failure than letting an unpaid test through.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not read `priority`, so a `stat` or `emergency` order is held like any other. That is an
 * open product decision, written up in the policy doc rather than quietly patched here — the fix
 * is one clause, and which way it should go is a clinical call, not an engineering one.
 */
export function isHeldForPayment(state: PaymentState | undefined, status: OrderStatus): boolean {
  return state === "unpaid" && HOLDABLE.includes(status);
}
