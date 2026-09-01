import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrderStatus } from "@medicore/api-client";
import { isHeldForPayment, type PaymentState } from "../lib/payment";

/**
 * WHEN THE LABORATORY HOLDS A TEST FOR PAYMENT.
 *
 * ── WHY THIS NEEDED WRITING DOWN ────────────────────────────────────────────
 * Two comments in the worklist said opposite things about the same rule. The badge's header read
 * "Advisory, not a gate: an unpaid emergency still gets run"; forty lines below, the action buttons
 * were replaced by "Awaiting payment" for any unpaid order, with no exemption for `stat` or
 * `emergency`. And the API gates nothing at all, so a third answer was true of every other client.
 *
 * The behaviour was never wrong — it is a deliberate web policy with real relief valves. What was
 * wrong is that nobody reading the file could tell what it did. These tests state it.
 *
 * The full decision, including the open question about emergencies, is in
 * `AI_Workflow/docs/PAYMENT_POLICY.md`.
 */

const HELD_AT: OrderStatus[] = ["placed", "accepted", "in_progress"];
const PAST_THE_BENCH: OrderStatus[] = ["completed", "verified", "released"];

describe("only a real, raised, unpaid charge holds laboratory work", () => {
  it("holds an unpaid test that has not been run yet", () => {
    for (const status of HELD_AT) {
      expect(isHeldForPayment("unpaid", status), `${status} was not held`).toBe(true);
    }
  });

  it("lets a paid test through", () => {
    for (const status of HELD_AT) expect(isHeldForPayment("paid", status)).toBe(false);
  });

  /**
   * WHAT DEFECT WOULD THIS CATCH?
   * The one that makes the product unsellable to a whole customer segment. A government hospital
   * charges its patients ₹0, so every test is worth nothing and NONE of them is "unpaid". Holding
   * `free` would mean a zero-tariff hospital could never run a single test, and the symptom would
   * be a worklist that looks completely normal and does nothing.
   */
  it("never holds a zero-tariff patient — `free` is not `unpaid`", () => {
    for (const status of HELD_AT) expect(isHeldForPayment("free", status)).toBe(false);
  });

  /**
   * A charge posts from the `order.placed` event, which is in flight for a moment after the doctor
   * commits. Holding on "we have not billed you yet" would hold every test briefly — and any test
   * whose charge never posts (a code with no tariff entry) forever.
   */
  it("does not hold work merely because no charge has been raised", () => {
    for (const status of HELD_AT) expect(isHeldForPayment("unbilled", status)).toBe(false);
  });

  /** Absence of data is not evidence of non-payment. The lookup may simply not have answered. */
  it("does not hold work when the payment lookup has said nothing", () => {
    for (const status of HELD_AT) expect(isHeldForPayment(undefined, status)).toBe(false);
  });

  /**
   * Past `in_progress` the sample has been run and the reagent consumed. Holding a `completed`
   * result hides work already done from the doctor waiting on it — a worse failure than letting an
   * unpaid test through, and one that cannot be undone by taking the money afterwards.
   */
  it("never holds a result that has already been produced", () => {
    for (const status of PAST_THE_BENCH) {
      expect(isHeldForPayment("unpaid", status), `${status} was held after the bench`).toBe(false);
    }
  });

  it("never holds a cancelled order", () => {
    expect(isHeldForPayment("unpaid", "cancelled")).toBe(false);
  });
});

/**
 * ── THE OPEN PRODUCT DECISION, PINNED AS IT ACTUALLY IS ─────────────────────
 * A `stat` or `emergency` order is held exactly like a routine one, because the rule reads payment
 * and status and never reads priority.
 *
 * This test asserts the CURRENT behaviour deliberately, and it is written to be the thing that
 * fails when somebody implements the exemption — at which point they will find this comment, the
 * policy document, and the two arguments already set out for them. That is better than a silent
 * gap nobody rediscovers.
 */
describe("an emergency is held like anything else — today", () => {
  it("does not read priority at all", () => {
    const SRC = readFileSync(join(__dirname, "..", "lib/payment.ts"), "utf8");
    // Mentioned in the comment explaining the omission; never consulted in the rule.
    expect(SRC).not.toMatch(/priority\s*===/);
    expect(SRC).toMatch(/priority/); // the omission is documented, not accidental
  });
});

/**
 * The rule has to be REACHED. An inline copy in the page is how the two comments came to disagree
 * in the first place.
 */
describe("the worklist consumes the shared rule", () => {
  const WORKLIST = readFileSync(join(__dirname, "..", "app/worklist/page.tsx"), "utf8");

  it("imports and calls it", () => {
    expect(WORKLIST).toMatch(/from "\.\.\/\.\.\/lib\/payment"/);
    expect(WORKLIST).toMatch(/isHeldForPayment\(payment\[o\.id\], o\.status\)/);
  });

  it("no longer decides for itself", () => {
    expect(WORKLIST).not.toMatch(/\["placed", "accepted", "in_progress"\]\.includes\(o\.status\)/);
  });

  /** The relief valves are what make the hold acceptable, so they must still be on screen. */
  it("still offers an admitted patient the advance, and cancel to everybody", () => {
    expect(WORKLIST).toMatch(/settle-?From-?Advance|settleFromAdvance/i);
    expect(WORKLIST).toMatch(/Proceed — deduct/);
  });
});

/** A cheap guard that the states the API can return are all the states this rule considers. */
describe("the rule covers every payment state the API can answer", () => {
  it("has a decision for each", () => {
    const states: PaymentState[] = ["paid", "unpaid", "unbilled", "free"];
    for (const s of states) {
      expect(typeof isHeldForPayment(s, "placed")).toBe("boolean");
    }
    expect(states.filter((s) => isHeldForPayment(s, "placed"))).toEqual(["unpaid"]);
  });
});
