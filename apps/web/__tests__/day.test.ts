/**
 * Branch-local calendar days.
 *
 * ── THE PROCESS TIMEZONE IS DELIBERATELY WRONG IN HERE ──────────────────────
 * `vitest.config.ts` does not pin a TZ, so these run in whatever zone the machine is in — and that
 * is the point. Every assertion below names the zone it is asking about, so a test that quietly
 * depended on the runner's clock would fail on somebody else's laptop rather than on a customer's
 * report. Where a case is only meaningful with a gap between the two, it uses a zone the runner
 * cannot plausibly be in (America/New_York against Asia/Kolkata, and vice versa).
 *
 * The two bugs being pinned:
 *   · a date-only value must not move when it is serialized (the Reports/MRD month presets)
 *   · "today" must be the ward's today, not the reader's (the theatre/ambulance boards)
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_ZONE,
  addDays,
  dayKeyInZone,
  dayRangeInZone,
  endOfPreviousMonth,
  isValidZone,
  resolveZone,
  startOfDayInZone,
  startOfMonth,
  startOfMonthsAgo,
  todayInZone,
} from "../lib/day";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

describe("isValidZone", () => {
  it("accepts real IANA names, including the modern spelling of India's", () => {
    // `Intl.supportedValuesOf` carries the legacy `Asia/Calcutta` and NOT this one, which is why
    // the check is shape-then-probe rather than a list lookup.
    expect(isValidZone("Asia/Kolkata")).toBe(true);
    expect(isValidZone("America/New_York")).toBe(true);
    expect(isValidZone("UTC")).toBe(true);
  });

  it("rejects the abbreviations Intl would silently resolve to the wrong place", () => {
    // `EST` resolves to America/Panama, which never observes DST — correct for half the year,
    // which is the worst possible failure mode.
    expect(isValidZone("EST")).toBe(false);
    expect(isValidZone("IST")).toBe(false);
    expect(isValidZone("+05:30")).toBe(false);
    expect(isValidZone("Asia/Kolkatta")).toBe(false);
    expect(isValidZone(undefined)).toBe(false);
  });
});

describe("resolveZone", () => {
  it("prefers the first usable candidate", () => {
    expect(resolveZone(NY, IST)).toBe(NY);
    expect(resolveZone(undefined, IST)).toBe(IST);
  });

  it("falls through a zone the hospital typed wrongly rather than crashing on it", () => {
    expect(resolveZone("IST", NY)).toBe(NY);
  });

  /** Never the device's. A device zone is a property of the reader; a clinical day is not. */
  it("ends at the platform default, not the browser", () => {
    expect(resolveZone(undefined, undefined)).toBe(PLATFORM_DEFAULT_ZONE);
    expect(resolveZone("nonsense")).toBe(PLATFORM_DEFAULT_ZONE);
  });
});

describe("dayKeyInZone — which day an instant belongs to", () => {
  /** THE BUG. 18:30 UTC is already tomorrow in India; the old code called it today. */
  it("puts a late-evening UTC instant on the next day in India", () => {
    const at = new Date("2026-08-12T18:30:00Z");
    expect(dayKeyInZone(at, IST)).toBe("2026-08-13");
    expect(dayKeyInZone(at, "UTC")).toBe("2026-08-12");
    expect(dayKeyInZone(at, NY)).toBe("2026-08-12");
  });

  it("puts an early-morning IST instant on the previous day in New York", () => {
    const at = new Date("2026-08-13T02:00:00Z"); // 07:30 IST, 22:00 previous day in NY
    expect(dayKeyInZone(at, IST)).toBe("2026-08-13");
    expect(dayKeyInZone(at, NY)).toBe("2026-08-12");
  });

  it("crosses the year boundary in the right direction", () => {
    const at = new Date("2025-12-31T20:00:00Z"); // 01:30 on 1 Jan in India
    expect(dayKeyInZone(at, IST)).toBe("2026-01-01");
    expect(dayKeyInZone(at, "UTC")).toBe("2025-12-31");
  });

  it("todayInZone is the same answer for an injected now", () => {
    expect(todayInZone(IST, new Date("2026-08-12T18:30:00Z"))).toBe("2026-08-13");
    expect(todayInZone(NY, new Date("2026-08-12T18:30:00Z"))).toBe("2026-08-12");
  });
});

describe("startOfDayInZone — what a date-only value means on the wire", () => {
  /**
   * THE CRITICAL RULE: a date-only value must not move. 13 Aug in Kolkata begins at 18:30 UTC on
   * the 12th; round-tripping it back through `dayKeyInZone` must land on 13 Aug again.
   */
  it("does not move a date-only value when it is serialized", () => {
    for (const zone of [IST, NY, "UTC", "Europe/London", "Pacific/Auckland"]) {
      for (const key of [
        "2026-08-13",
        "2026-01-01",
        "2026-12-31",
        "2026-02-28",
        // Every DST transition these zones have in 2026 — the days a naive conversion moves.
        "2026-03-08",
        "2026-03-29",
        "2026-04-05",
        "2026-09-27",
        "2026-10-25",
        "2026-11-01",
      ]) {
        expect(dayKeyInZone(startOfDayInZone(key, zone), zone)).toBe(key);
      }
    }
  });

  /**
   * THE CASE THAT NEEDS THE SECOND PASS, and the reason it is not optional.
   *
   * New Zealand starts daylight saving at 02:00 on 27 September 2026. Midnight UTC that day is
   * already noon in Auckland — AFTER the shift — so the offset read at the naive timestamp is
   * +13, and subtracting it lands at 11:00 UTC on the 26th, which is 23:00 on the 26th locally.
   * A single-pass conversion therefore returns THE WRONG DAY: a date-only value silently moves
   * backwards, which is precisely what this module exists to prevent.
   *
   * Re-reading the offset at the guess (+12, before the shift) corrects it to local midnight.
   */
  it("gets the right day when the offset at UTC midnight is not the offset at local midnight", () => {
    const auckland = "Pacific/Auckland";
    expect(dayKeyInZone(startOfDayInZone("2026-09-27", auckland), auckland)).toBe("2026-09-27");
    expect(startOfDayInZone("2026-09-27", auckland).toISOString()).toBe("2026-09-26T12:00:00.000Z");
  });

  it("is 18:30 the previous day in UTC, for India", () => {
    expect(startOfDayInZone("2026-08-13", IST).toISOString()).toBe("2026-08-12T18:30:00.000Z");
  });

  it("is 04:00 UTC in New York in summer and 05:00 in winter", () => {
    // The offset itself changes — this is the reason the conversion cannot be a constant.
    expect(startOfDayInZone("2026-07-01", NY).toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(startOfDayInZone("2026-01-01", NY).toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  /** Spring forward: 8 March 2026, 02:00 → 03:00 in New York. Midnight itself is untouched. */
  it("holds across a DST spring-forward", () => {
    expect(startOfDayInZone("2026-03-08", NY).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(dayKeyInZone(startOfDayInZone("2026-03-08", NY), NY)).toBe("2026-03-08");
    // The day after the shift is an hour closer to UTC.
    expect(startOfDayInZone("2026-03-09", NY).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  /** Fall back: 1 November 2026, 02:00 → 01:00. The 01:00 hour happens twice. */
  it("holds across a DST fall-back", () => {
    expect(startOfDayInZone("2026-11-01", NY).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(dayKeyInZone(startOfDayInZone("2026-11-01", NY), NY)).toBe("2026-11-01");
    expect(startOfDayInZone("2026-11-02", NY).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("addDays — calendar arithmetic, not millisecond arithmetic", () => {
  it("steps ordinary days, months and years", () => {
    expect(addDays("2026-08-13", 1)).toBe("2026-08-14");
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-08-13", 30)).toBe("2026-09-12");
  });

  it("handles a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  /**
   * The mistake this replaces, demonstrated rather than asserted about.
   *
   * Stepping a ZONED instant by a fixed 24 hours across a spring-forward lands an hour off local
   * midnight, because that day is only 23 hours long. The instant is still inside the right date
   * here, but the drift accumulates over the 28-day loop the appointments screen runs — which is
   * why the key, not the timestamp, is the unit of calendar arithmetic.
   */
  it("does not drift across a 23-hour day, the way stepping an instant does", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    const steppedByMs = new Date(startOfDayInZone("2026-03-08", NY).getTime() + 86_400_000);
    expect(startOfDayInZone("2026-03-09", NY).getTime()).not.toBe(steppedByMs.getTime());
  });

  /**
   * And the whole-app version of the same rule: a day key must never be built from LOCAL parts.
   * In any zone east of Greenwich `new Date(y, m, d)` is the previous day once read as UTC.
   */
  it("is not the same as formatting a local Date, in a zone that is not UTC", () => {
    const localMidnight = new Date(2026, 7, 13); // 13 Aug, in whatever zone this runs in
    const viaLocal = localMidnight.toISOString().slice(0, 10);
    const viaKey = addDays("2026-08-13", 0);
    expect(viaKey).toBe("2026-08-13");
    if (localMidnight.getTimezoneOffset() < 0) {
      // East of Greenwich — the pattern that produced the reported bug.
      expect(viaLocal).not.toBe(viaKey);
    }
  });
});

describe("month helpers — the presets that were a day out", () => {
  it("starts a month on the 1st, whatever the zone the key came from", () => {
    expect(startOfMonth("2026-08-13")).toBe("2026-08-01");
    expect(startOfMonth("2026-01-31")).toBe("2026-01-01");
  });

  it("ends the previous month on its real last day", () => {
    expect(endOfPreviousMonth("2026-08-13")).toBe("2026-07-31");
    expect(endOfPreviousMonth("2026-03-05")).toBe("2026-02-28");
    expect(endOfPreviousMonth("2028-03-05")).toBe("2028-02-29");
    expect(endOfPreviousMonth("2026-01-15")).toBe("2025-12-31");
  });

  it("steps whole months back to the 1st", () => {
    expect(startOfMonthsAgo("2026-08-13", 0)).toBe("2026-08-01");
    expect(startOfMonthsAgo("2026-08-13", 1)).toBe("2026-07-01");
    expect(startOfMonthsAgo("2026-08-13", 8)).toBe("2025-12-01");
  });

  /**
   * THE REPORTED DEFECT, end to end. In India on 13 Aug 2026 the "This month" preset produced
   * 2026-07-31 because it formatted a local midnight through `toISOString()`.
   */
  it("produces 2026-08-01 for This month in India on 13 Aug 2026", () => {
    const today = todayInZone(IST, new Date("2026-08-13T04:00:00Z"));
    expect(today).toBe("2026-08-13");
    expect(startOfMonthsAgo(today, 0)).toBe("2026-08-01");
  });

  it("produces 2026-07-01 .. 2026-07-31 for Last month, not 06-30 .. 07-30", () => {
    const today = todayInZone(IST, new Date("2026-08-13T04:00:00Z"));
    expect(startOfMonthsAgo(today, 1)).toBe("2026-07-01");
    expect(endOfPreviousMonth(startOfMonth(today))).toBe("2026-07-31");
  });

  /** The early-morning case: 02:00 IST is still the 13th, and the month still starts on the 1st. */
  it("is right at 02:00 IST, when the browser's UTC day is still yesterday", () => {
    const at = new Date("2026-08-12T20:30:00Z"); // 02:00 on the 13th in India
    expect(todayInZone(IST, at)).toBe("2026-08-13");
    expect(at.toISOString().slice(0, 10)).toBe("2026-08-12"); // what the old code produced
  });
});

describe("dayRangeInZone — half-open, in the branch's calendar", () => {
  it("spans from the first midnight to the one after the last day", () => {
    expect(dayRangeInZone("2026-08-01", "2026-08-31", IST)).toEqual({
      from: "2026-07-31T18:30:00.000Z",
      to: "2026-08-31T18:30:00.000Z",
    });
  });

  it("covers a single day", () => {
    const one = dayRangeInZone("2026-08-13", "2026-08-13", IST);
    expect(one.from).toBe("2026-08-12T18:30:00.000Z");
    expect(one.to).toBe("2026-08-13T18:30:00.000Z");
  });

  /**
   * A payment taken at 23:59:59.500 on the last day must be inside the range. A `<= 23:59:59.999`
   * bound is a real instant that a real transaction can land after, and the money would vanish
   * from the day's takings.
   */
  it("includes the final millisecond of the last day", () => {
    const { from, to } = dayRangeInZone("2026-08-13", "2026-08-13", IST);
    const lastMoment = new Date(startOfDayInZone("2026-08-14", IST).getTime() - 1);
    expect(lastMoment.toISOString() >= from).toBe(true);
    expect(lastMoment.toISOString() < to).toBe(true);
  });

  it("excludes the first instant of the day after", () => {
    const { to } = dayRangeInZone("2026-08-13", "2026-08-13", IST);
    expect(startOfDayInZone("2026-08-14", IST).toISOString()).toBe(to);
  });

  it("gives two different hospitals in two zones two different ranges for the same dates", () => {
    const india = dayRangeInZone("2026-08-01", "2026-08-31", IST);
    const newYork = dayRangeInZone("2026-08-01", "2026-08-31", NY);
    expect(india.from).not.toBe(newYork.from);
    expect(india.to).not.toBe(newYork.to);
  });

  it("stays correct across a DST boundary inside the range", () => {
    const march = dayRangeInZone("2026-03-01", "2026-03-31", NY);
    expect(march.from).toBe("2026-03-01T05:00:00.000Z"); // before the shift
    expect(march.to).toBe("2026-04-01T04:00:00.000Z"); // after it
  });
});

/**
 * The pattern that caused all of this. Once every instance is gone, this stops a new one arriving:
 * a day key built by slicing an ISO string is UTC by construction, and there is no screen in this
 * app whose calendar is UTC.
 */
/**
 * Comments stripped before matching — deliberately.
 *
 * The first version of this guard failed on the header of `reports/page.tsx`, which EXPLAINS the
 * bad pattern in order to stop it coming back. A guard that punishes the documentation written to
 * prevent a defect teaches people to delete the documentation.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the defect cannot come back unnoticed", () => {
  it("no page derives a day key from toISOString()", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const roots = ["app", "components", "lib"];
    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".")) continue;
          await walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          // `lib/day.ts` uses it legitimately: its Dates are built with `Date.UTC`, so UTC IS the
          // right reading. Everywhere else it is a local Date being misread as a UTC one.
          if (full.endsWith(join("lib", "day.ts"))) continue;
          if (
            /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.test(
              codeOf(await readFile(full, "utf8")),
            )
          ) {
            offenders.push(full);
          }
        }
      }
    }

    for (const root of roots) await walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});
