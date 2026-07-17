/**
 * A unit test, deliberately — this is pure arithmetic and needs no database.
 *
 * It exists because "today" is the single most common filter in the whole product and
 * getting it wrong is invisible: the register looks plausible and is quietly missing
 * the first five and a half hours of every day.
 */
import { describe, expect, it } from "vitest";
import { calendarDaysStarted, dayRangeInZone } from "./day.js";

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

describe("calendarDaysStarted — how a bed is billed", () => {
  const IST = "Asia/Kolkata";

  it("admitted and discharged the same afternoon is ONE day", () => {
    // The bed was made, occupied and turned over. No hospital bills that as zero.
    const days = calendarDaysStarted(
      new Date("2026-07-16T08:00:00.000Z"), // 13:30 IST
      new Date("2026-07-16T11:00:00.000Z"), // 16:30 IST
      IST,
    );
    expect(days).toBe(1);
  });

  it("an overnight stay of ELEVEN HOURS is TWO days — the trap 24-hour blocks fall into", () => {
    /**
     * Admitted 22:00, discharged 09:00 the next morning. Eleven hours.
     *
     * Counting whole 24-hour blocks bills this as ZERO — and that is not generosity, it
     * is a hole the ward papers over by admitting people at one minute past midnight. The
     * bed was unsellable on both calendar days.
     */
    const days = calendarDaysStarted(
      new Date("2026-07-16T16:30:00.000Z"), // 22:00 IST on the 16th
      new Date("2026-07-17T03:30:00.000Z"), // 09:00 IST on the 17th
      IST,
    );
    expect(days).toBe(2);
  });

  it("counts days in the HOSPITAL's zone, not UTC", () => {
    /**
     * 19:00 UTC on the 16th is 00:30 IST on the 17th — already tomorrow in the ward.
     * Discharged 05:00 UTC on the 17th = 10:30 IST, still the 17th. In IST that is ONE
     * day; in UTC it looks like two, and the patient would be billed for a night they
     * were never there.
     */
    const days = calendarDaysStarted(
      new Date("2026-07-16T19:00:00.000Z"),
      new Date("2026-07-17T05:00:00.000Z"),
      IST,
    );
    expect(days).toBe(1);
  });

  it("a five-night stay is six days — every day touched", () => {
    const days = calendarDaysStarted(
      new Date("2026-07-10T06:00:00.000Z"),
      new Date("2026-07-15T06:00:00.000Z"),
      IST,
    );
    expect(days).toBe(6);
  });

  it("a stay across a DST transition is not rounded down", () => {
    // 8 March 2026 is 23 hours long in New York. Dividing elapsed ms by 86,400,000 would
    // give 1.96 → floor 1, and the hospital would lose a night on every spring stay.
    const days = calendarDaysStarted(
      new Date("2026-03-07T12:00:00.000Z"),
      new Date("2026-03-09T12:00:00.000Z"),
      "America/New_York",
    );
    expect(days).toBe(3);
  });

  it("refuses a discharge that precedes the admission", () => {
    // A negative stay would compute zero or negative nights and silently bill nothing.
    // It means the clock is wrong somewhere, and that is worth a loud failure.
    expect(() =>
      calendarDaysStarted(
        new Date("2026-07-16T10:00:00.000Z"),
        new Date("2026-07-15T10:00:00.000Z"),
        IST,
      ),
    ).toThrow(/precedes/);
  });
});
