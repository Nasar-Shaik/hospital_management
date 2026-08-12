/**
 * TIME ZONE VALIDATION — the two traps, both measured on this runtime.
 *
 * A zone reaches `Intl.DateTimeFormat` in `dayKeyInZone`, which every bed-day charge is counted
 * from. Unvalidated it was a 500 waiting on a typo; validated with either obvious check alone it
 * would be wrong in one of two opposite directions, which is what these tests pin.
 */
import { describe, expect, it } from "vitest";
import { isValidTimeZone, zoneOrDefault, IANA_ZONE_SHAPE } from "./zone.js";
import { dayKeyInZone, calendarDaysStarted } from "./day.js";

describe("the abbreviations Intl accepts and silently gets wrong", () => {
  /**
   * Measured, not assumed: `Intl` resolves `EST` to `America/Panama` — a zone with NO daylight
   * saving — and `IST` to `Asia/Calcutta`. A hospital that typed `EST` would be an hour out for
   * half the year with nothing reporting an error. This is why an `Intl` probe alone is not the
   * rule.
   */
  it.each(["IST", "EST", "GMT", "PST", "CET"])("refuses the abbreviation %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });

  it("refuses a bare UTC offset, which Intl also accepts", () => {
    expect(isValidTimeZone("+05:30")).toBe(false);
    expect(isValidTimeZone("-08:00")).toBe(false);
  });

  it("proves the leniency it is guarding against is real on this runtime", () => {
    // If Intl ever starts rejecting these on its own, the shape rule becomes belt-and-braces
    // rather than the load-bearing half — worth knowing, hence an explicit control.
    const accepted = new Intl.DateTimeFormat("en-GB", { timeZone: "EST" }).resolvedOptions()
      .timeZone;
    expect(accepted).not.toBe("EST");
  });
});

describe("Asia/Kolkata — the zone a membership test would reject", () => {
  /**
   * `Intl.supportedValuesOf("timeZone")` carries the LEGACY `Asia/Calcutta` and does not contain
   * `Asia/Kolkata`, which is this product's default and the correct modern name. Using that list
   * as a membership test would reject the one zone almost every tenant needs.
   */
  it("accepts the modern name", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("accepts the legacy name too — existing records must keep working", () => {
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
  });

  it("documents why supportedValuesOf is NOT the check", () => {
    const list = Intl.supportedValuesOf("timeZone");
    expect(list).not.toContain("Asia/Kolkata");
    expect(list).toContain("Asia/Calcutta");
  });
});

describe("ordinary zones", () => {
  it.each([
    "UTC",
    "America/New_York",
    "Europe/London",
    "Australia/Sydney",
    "America/Argentina/Buenos_Aires",
    "Etc/GMT+5",
  ])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it("refuses a well-shaped name this runtime does not know", () => {
    // Shape alone is not enough either — the Intl probe is the half that catches this.
    expect(IANA_ZONE_SHAPE.test("Nowhere/Fake")).toBe(true);
    expect(isValidTimeZone("Nowhere/Fake")).toBe(false);
  });

  it("refuses nothing-at-all rather than throwing", () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    expect(isValidTimeZone("../../etc/passwd")).toBe(false);
  });
});

describe("a bad zone degrades, it does not 500", () => {
  /**
   * The edge refuses new bad data; it cannot fix a branch row written before the rule existed.
   * `Intl` throws a RangeError on an unknown zone, and in `calendarDaysStarted` that is one bad
   * branch record turning into a 500 on every bed-day for that site — a ward that cannot
   * discharge anybody. A stay costed in the default zone is wrong by at most a day boundary.
   */
  it("substitutes the fallback", () => {
    expect(zoneOrDefault("Garbage/Nope", "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneOrDefault(undefined, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneOrDefault("Europe/London", "Asia/Kolkata")).toBe("Europe/London");
  });

  it("falls back to UTC when even the fallback is broken", () => {
    expect(zoneOrDefault("Garbage/Nope", "Also/Garbage")).toBe("UTC");
  });

  it("keeps dayKeyInZone from throwing on a legacy bad row", () => {
    const at = new Date("2026-08-12T18:30:00.000Z");
    expect(() => dayKeyInZone(at, "EST")).not.toThrow();
    expect(() => dayKeyInZone(at, "Garbage/Nope")).not.toThrow();
    // …and the substituted answer is the one the default zone gives. 18:30Z is past midnight IST.
    expect(dayKeyInZone(at, "Garbage/Nope")).toBe("2026-08-13");
  });

  it("keeps a bed-day count from throwing, which is where this reached production code", () => {
    const from = new Date("2026-08-10T04:00:00.000Z");
    const to = new Date("2026-08-12T04:00:00.000Z");
    expect(() => calendarDaysStarted(from, to, "Garbage/Nope")).not.toThrow();
    expect(calendarDaysStarted(from, to, "Garbage/Nope")).toBeGreaterThan(0);
  });

  it("still honours a VALID zone — the fallback is not a blanket override", () => {
    const at = new Date("2026-08-12T18:30:00.000Z");
    expect(dayKeyInZone(at, "UTC")).toBe("2026-08-12");
    expect(dayKeyInZone(at, "Asia/Kolkata")).toBe("2026-08-13");
  });
});
