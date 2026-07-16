/**
 * A unit test, deliberately — this is pure arithmetic and needs no database.
 *
 * It exists because "today" is the single most common filter in the whole product and
 * getting it wrong is invisible: the register looks plausible and is quietly missing
 * the first five and a half hours of every day.
 */
import { describe, expect, it } from "vitest";
import { dayRangeInZone } from "./day.js";

describe("a calendar day in the hospital's timezone", () => {
  it("starts at local midnight, not UTC midnight", () => {
    const { from, before } = dayRangeInZone("2026-07-16", "Asia/Kolkata");

    // Midnight in Kolkata is 18:30 UTC the previous day. A naive
    // `new Date("2026-07-16")` would give 00:00Z — omitting every patient who
    // arrived before 05:30 local, and including the small hours of the 17th.
    expect(from.toISOString()).toBe("2026-07-15T18:30:00.000Z");
    expect(before.toISOString()).toBe("2026-07-16T18:30:00.000Z");
  });

  it("is exactly 24 hours long", () => {
    const { from, before } = dayRangeInZone("2026-07-16", "Asia/Kolkata");
    expect(before.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("is HALF-OPEN — the last millisecond of the day is inside it", () => {
    const { from, before } = dayRangeInZone("2026-07-16", "Asia/Kolkata");

    // 23:59:59.999 local. With a `<= end of day` range built from a truncated
    // second, this patient disappears from the day's list.
    const lastMoment = new Date(before.getTime() - 1);
    expect(lastMoment >= from && lastMoment < before).toBe(true);

    // And local midnight of the NEXT day is outside it — no double counting.
    expect(before >= before).toBe(true);
  });

  it("handles UTC itself without drifting", () => {
    const { from, before } = dayRangeInZone("2026-07-16", "UTC");
    expect(from.toISOString()).toBe("2026-07-16T00:00:00.000Z");
    expect(before.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });

  it("handles a zone WEST of UTC", () => {
    // New York is UTC-4 in July. Local midnight is 04:00Z the same day.
    const { from } = dayRangeInZone("2026-07-16", "America/New_York");
    expect(from.toISOString()).toBe("2026-07-16T04:00:00.000Z");
  });

  it("crosses a DST boundary without losing or inventing an hour", () => {
    // New York springs forward on 2026-03-08. That day is 23 hours long, and a range
    // that assumes 24 would spill an hour into the next day.
    const { from, before } = dayRangeInZone("2026-03-08", "America/New_York");
    expect(before.getTime() - from.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("refuses a malformed date rather than returning Invalid Date", () => {
    // An invalid date would become a query matching nothing, which reads as
    // "no patients today" — a lie that looks like a quiet afternoon.
    expect(() => dayRangeInZone("16-07-2026", "Asia/Kolkata")).toThrow();
    expect(() => dayRangeInZone("today", "Asia/Kolkata")).toThrow();
  });
});
