import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Order } from "@medicore/api-client";
import {
  awaitingRelease,
  CRITICAL_PENDING_LABEL,
  isCriticalPending,
  isResultReadable,
} from "../lib/results";

/**
 * WHEN A DOCTOR MAY READ A RESULT — and the regression that made this file necessary.
 *
 * The rule was written three times and came out three different ways. The consultation screen
 * gated on `released`; mobile gated on `released` and its header claimed "The web app enforces
 * exactly this"; and the patient chart rendered `result.summary` at ANY status. So the same doctor,
 * reading the same order on a different screen, saw a number that no second pair of eyes had
 * signed off — which is the precise failure `STATE_MACHINE_CATALOG` §15 splits `completed`,
 * `verified` and `released` to prevent.
 *
 * The gate now lives in `lib/results`. These tests pin the rule AND pin that both screens ask it,
 * because a helper nothing imports is the same bug in a new file.
 */

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    encounterId: "e1",
    patientId: "p1",
    episodeId: "ep1",
    category: "lab",
    code: "K",
    name: "Serum Potassium",
    priority: "routine",
    status: "completed",
    orderedBy: "u1",
    orderedAt: "2026-08-18T04:00:00.000Z",
    history: [],
    createdAt: "2026-08-18T04:00:00.000Z",
    ...over,
  }) as Order;

const RESULT = { summary: "Potassium 7.2 mmol/L", critical: true };

describe("a number that has been run but not signed off", () => {
  it("is NOT readable at completed — the machine produced it, nobody checked it", () => {
    expect(isResultReadable(order({ status: "completed", result: RESULT }))).toBe(false);
  });

  /**
   * The rung people forget. Verification is a CLINICAL act; release is a DISCLOSURE decision, and
   * they are not the same — an HIV result is given with counselling, not by a portal at 2am.
   */
  it("is NOT readable at verified either — signed off is not the same as disclosed", () => {
    expect(isResultReadable(order({ status: "verified", result: RESULT }))).toBe(false);
  });

  it("becomes readable at released", () => {
    expect(isResultReadable(order({ status: "released", result: RESULT }))).toBe(true);
  });

  /** A released order with no result at all is not a readable result — pharmacy walks this machine. */
  it("is not readable when released carries nothing to read", () => {
    expect(isResultReadable(order({ status: "released" }))).toBe(false);
  });

  it("is never readable once cancelled", () => {
    expect(isResultReadable(order({ status: "cancelled", result: RESULT }))).toBe(false);
  });
});

describe("a critical value before it has been released", () => {
  /**
   * WHAT DEFECT WOULD THIS CATCH?
   * Silence on the chart after the hospital has already emailed the doctor. `order.critical` is
   * sent synchronously at completion, carrying the value and the sentence "This value has NOT yet
   * been verified by a pathologist" — so a chart that showed an ordinary-looking row to the doctor
   * who just read that alert would be actively misleading.
   */
  it("is flagged at completed, before any verification", () => {
    expect(isCriticalPending(order({ status: "completed", result: RESULT }))).toBe(true);
  });

  it("is still flagged at verified, because release is the gate", () => {
    expect(isCriticalPending(order({ status: "verified", result: RESULT }))).toBe(true);
  });

  /** Once released it is an ordinary readable result, and the "not yet verified" wording is a lie. */
  it("stops being PENDING the moment it is released", () => {
    expect(isCriticalPending(order({ status: "released", result: RESULT }))).toBe(false);
  });

  it("says nothing about an ordinary unreleased result", () => {
    expect(
      isCriticalPending(order({ status: "completed", result: { summary: "11.9 g/dL" } })),
    ).toBe(false);
  });

  /**
   * The words are the whole bargain. Mobile refuses any early critical marker precisely because a
   * bare red pill "would push a clinician to act on a number nobody has confirmed"; labelling it
   * is what answers that objection, so the label must actually say so.
   */
  it("is labelled as unverified, not merely as critical", () => {
    expect(CRITICAL_PENDING_LABEL).toMatch(/not yet verified/i);
    expect(CRITICAL_PENDING_LABEL).toMatch(/critical/i);
  });
});

describe("what the doctor is told while they wait", () => {
  it("names what is being waited FOR, not what the lab has done", () => {
    expect(awaitingRelease(order({ status: "completed" }))).toBe("Awaiting verification");
    expect(awaitingRelease(order({ status: "verified" }))).toBe("Awaiting release");
  });

  it("distinguishes not-started from being-run, so nobody chases a test twice", () => {
    expect(awaitingRelease(order({ status: "placed" }))).toBe("Not started");
    expect(awaitingRelease(order({ status: "accepted" }))).toBe("Not started");
    expect(awaitingRelease(order({ status: "in_progress" }))).toBe("Being run");
  });

  it("defers to the caller for the endings, which have their own display", () => {
    expect(awaitingRelease(order({ status: "released" }))).toBeNull();
    expect(awaitingRelease(order({ status: "cancelled" }))).toBeNull();
  });
});

/**
 * ── THE RULE HAS TO BE REACHED, NOT MERELY CORRECT ──────────────────────────
 * Both doctor-facing screens must ask the shared gate. These fail if either reverts to deciding
 * for itself — which is exactly how the two came to disagree in the first place.
 */
describe("both doctor-facing screens consume the shared gate", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  const CHART = read("app/patients/[id]/page.tsx");
  const CONSULTATION = read("app/my-patients/page.tsx");

  it("the patient chart imports and calls it", () => {
    expect(CHART).toMatch(/from "\.\.\/\.\.\/\.\.\/lib\/results"/);
    expect(CHART).toMatch(/isResultReadable\(o\)/);
  });

  it("the consultation screen imports and calls it", () => {
    expect(CONSULTATION).toMatch(/from "\.\.\/\.\.\/lib\/results"/);
    expect(CONSULTATION).toMatch(/isResultReadable\(o\)/);
  });

  /**
   * The specific regression: the chart rendering `result.summary` with no gate in front of it.
   * Asserted on the source because the alternative is mounting a page with an API client, a
   * session and a provider tree to prove one conditional.
   */
  it("neither screen renders a result summary outside the gate", () => {
    for (const [name, src] of [
      ["chart", CHART],
      ["consultation", CONSULTATION],
    ] as const) {
      // The ternary the chart used to open with — `{o.result?.summary ? (`. The negative
      // lookahead keeps `??` out of it: `{o.result?.summary ?? "Released"}` sits INSIDE the
      // gate and is the correct form.
      const ungated = /\{o\.result\?\.summary \?(?!\?)/.exec(src);
      expect(ungated, `${name} renders result.summary without asking isResultReadable`).toBeNull();
    }
  });
});
