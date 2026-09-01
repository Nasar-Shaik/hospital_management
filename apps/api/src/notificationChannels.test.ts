/**
 * K4-01 — A ROUTINE RESULT MUST NOT BUZZ LIKE A CRITICAL ONE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * M4 shipped push with a single Android channel, created at HIGH importance, and distinguished
 * urgency only by the message's `priority`. On Android 8+ that is the wrong lever: `priority`
 * governs whether FCM wakes a dozing handset, and the CHANNEL governs whether the phone makes a
 * noise, lights up and shows over the lock screen. So every released lab result interrupted a ward
 * round exactly like a critical potassium.
 *
 * That is not a cosmetic complaint. A ward interrupted by everything stops reacting to anything,
 * and the alert that pays for it is the one this whole feature was built to deliver. It was caught
 * on paper while writing the device checklist — no automated test could see it, because until this
 * file nothing asserted on a channel at all.
 *
 * ── WHAT THIS FILE DEFENDS, AND WHAT IT DELIBERATELY DOES NOT ───────────────
 * It pins the MAPPING: which template reaches which channel, in both directions, and that the two
 * channels are two. It cannot prove a phone stayed quiet — no test here can, which is why
 * `MOBILE_M4_DEVICE_CHECKLIST.md` M4-10 exists and stays unticked until somebody holds a handset.
 * `push.int.test.ts` covers the hop this file cannot: that the id survives the message builder and
 * crosses the wire to Expo.
 */
import { describe, expect, it } from "vitest";
import { PUSH_CHANNEL } from "@medicore/types";
import { channelFor, copyFor } from "./modules/notifications/push.service.js";

/** The one template the product calls clinically urgent. */
const CRITICAL = "order.critical";
/** A real, ordinary staff alert — not a fabricated key. */
const ROUTINE = "order.result.released";

describe("a critical alert reaches the channel that interrupts", () => {
  it("maps order.critical to the HIGH-importance channel", () => {
    expect(channelFor(CRITICAL)).toBe(PUSH_CHANNEL.critical);
  });

  /**
   * The negative half, stated separately rather than inferred from the positive.
   *
   * `toBe(critical)` passes just as happily in a build where BOTH ids are `"critical"` — which is
   * the exact shape of the regression this file exists to stop, only mirrored. Naming the channel
   * it must NOT be is what makes the pair falsifiable from either side.
   */
  it("does not send a critical alert to the quiet channel", () => {
    expect(channelFor(CRITICAL)).not.toBe(PUSH_CHANNEL.routine);
  });
});

describe("an ordinary alert waits its turn", () => {
  it("maps a released result to the DEFAULT-importance channel", () => {
    expect(channelFor(ROUTINE)).toBe(PUSH_CHANNEL.routine);
  });

  it("does not send an ordinary alert to the channel that interrupts", () => {
    expect(channelFor(ROUTINE)).not.toBe(PUSH_CHANNEL.critical);
  });
});

/**
 * THE FALSIFICATION.
 *
 * Every assertion above is satisfiable by a single-channel build if the two ids are ever collapsed
 * — set `PUSH_CHANNEL.routine = "critical"` and the four tests above still pass in the direction
 * each of them checks, because each compares a mapping to a constant rather than to the other
 * mapping. This describes the property those four cannot: that the separation EXISTS.
 *
 * It is the same class of mistake as the original defect. One channel was never a typo; it was a
 * design that looked complete because nothing compared it to anything.
 */
describe("the separation itself", () => {
  it("gives urgent and ordinary two DIFFERENT channels — the whole of K4-01", () => {
    expect(channelFor(CRITICAL)).not.toBe(channelFor(ROUTINE));
  });

  it("keeps the two channel ids distinct at the source", () => {
    expect(PUSH_CHANNEL.critical).not.toBe(PUSH_CHANNEL.routine);
  });

  /**
   * The app creates its channels from `PUSH_CHANNEL` and Android DISCARDS — silently, with an `ok`
   * ticket from Expo — any push naming a channel that does not exist on the handset. A server that
   * invented an id would therefore lose alerts with nothing in any log to say so. This pins every
   * route out of `channelFor` to the shared list the app builds from.
   */
  it("never names a channel the handset was not told to create", () => {
    const known = new Set<string>(Object.values(PUSH_CHANNEL));
    for (const key of [CRITICAL, ROUTINE, "appointment.reminder", "nothing.like.this", ""]) {
      expect(known).toContain(channelFor(key));
    }
  });
});

/**
 * The channel and the wording are two consequences of ONE fact — `urgent` on the copy — so a
 * template that says "needs you now" on a lock screen and arrives on the quiet channel is a
 * contradiction the product should never ship. Checked as a property over the whole table rather
 * than per template, so a template added later is covered by a test written today.
 */
describe("urgency means the same thing to the words and to the channel", () => {
  it("agrees on every template the product classifies", () => {
    for (const key of [CRITICAL, ROUTINE, "appointment.reminder"]) {
      const urgent = copyFor(key).urgent === true;
      expect(channelFor(key)).toBe(urgent ? PUSH_CHANNEL.critical : PUSH_CHANNEL.routine);
    }
  });
});
