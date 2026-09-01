/**
 * The dose schedule (M3-S1).
 *
 * ── THE ZONE IS THE POINT ───────────────────────────────────────────────────
 * `vitest.config.ts` pins `TZ: "Asia/Kolkata"`, so every test here uses `America/New_York` — 9.5
 * hours away, and DST-observing, which Kolkata is not. A schedule that read the process clock
 * would produce answers 9.5 hours out, and the assertions are written so that it could not
 * accidentally look right: each one names the wall-clock hour at the WARD **and** the UTC instant.
 */
import { describe, it, expect } from "vitest";
import { dosesInRange, slotFor, DEFAULT_ROUND_TIMES, type Course } from "./schedule.js";
import { DRUG_FREQUENCIES, type DrugFrequency } from "../prescriptions/prescription.model.js";

const NY = "America/New_York";
const KOLKATA = "Asia/Kolkata";

/** A course signed at a fixed instant, open-ended unless a test says otherwise. */
const signedAt = new Date("2026-06-10T12:00:00Z"); // 08:00 in New York, summer (UTC-4)
const course = (over: Partial<Course> = {}): Course => ({ signedAt, ...over });

/** The whole of one New York day, as UTC instants. Summer: midnight NY = 04:00Z. */
const day = (dayKey: string) => ({
  from: new Date(`${dayKey}T04:00:00Z`),
  before: new Date(`${dayKey}T04:00:00Z`.replace(dayKey, nextDay(dayKey))),
});

function nextDay(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The wall-clock hour an instant reads at the ward. */
function hourAt(at: Date, zone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(at),
  );
}

describe("every frequency is classified", () => {
  /**
   * The guard that matters most in this file. A frequency with no policy would silently never
   * become due — a drug that quietly disappears off the round is the worst possible failure mode,
   * and it would not look like a bug from any screen.
   */
  it("covers every value of DRUG_FREQUENCIES", () => {
    for (const f of DRUG_FREQUENCIES) {
      expect(DEFAULT_ROUND_TIMES[f], `${f} has no dose policy`).toBeDefined();
    }
    expect(Object.keys(DEFAULT_ROUND_TIMES).sort()).toEqual([...DRUG_FREQUENCIES].sort());
  });

  it("refuses a frequency it has never heard of rather than inventing a schedule", () => {
    const { from, before } = day("2026-06-11");
    let thrown: unknown;
    try {
      dosesInRange("TWICE_A_FORTNIGHT" as DrugFrequency, 0, course(), NY, from, before);
    } catch (err) {
      thrown = err;
    }
    // The envelope is the generic validation one; the refusal itself is in the details, which is
    // where a client reads it. Asserting on the message alone would pass for any 400 at all.
    expect(thrown).toMatchObject({
      code: "HMS-VAL-001",
      httpStatus: 400,
      details: { frequency: [expect.stringContaining("no dose schedule")] },
    });
  });
});

describe("clock-anchored rounds land on the ward clock", () => {
  const cases: [DrugFrequency, number[]][] = [
    ["OD", [8]],
    ["BD", [8, 20]],
    ["TDS", [8, 14, 20]],
    ["QID", [6, 12, 18, 22]],
    ["HS", [22]],
  ];

  for (const [frequency, hours] of cases) {
    it(`${frequency} → ${hours.join(", ")} at the ward`, () => {
      const { from, before } = day("2026-06-11");
      const doses = dosesInRange(frequency, 0, course(), NY, from, before);
      expect(doses.map((d) => hourAt(d.scheduledFor, NY))).toEqual(hours);
    });
  }

  /**
   * The falsifiable one. 08:00 in New York in June is 12:00Z — NOT 08:00Z, which is what a
   * schedule built on the process clock would produce, and not 02:30Z, which is what one built on
   * the pinned Kolkata test clock would produce.
   */
  it("OD is 12:00Z in June — not 08:00Z (process zone) and not the Kolkata equivalent", () => {
    const { from, before } = day("2026-06-11");
    const [dose] = dosesInRange("OD", 0, course(), NY, from, before);
    expect(dose?.scheduledFor.toISOString()).toBe("2026-06-11T12:00:00.000Z");
    expect(dose?.scheduledFor.getUTCHours()).not.toBe(8);
  });

  it("the same wall clock in Kolkata is a different instant", () => {
    const from = new Date("2026-06-10T18:30:00Z"); // midnight Kolkata
    const before = new Date("2026-06-11T18:30:00Z");
    const [dose] = dosesInRange("OD", 0, course(), KOLKATA, from, before);
    expect(hourAt(dose?.scheduledFor as Date, KOLKATA)).toBe(8);
    expect(dose?.scheduledFor.toISOString()).toBe("2026-06-11T02:30:00.000Z");
  });
});

describe("interval-anchored frequencies count from the first dose", () => {
  it("Q8H steps 8 hours from the signature, not from midnight", () => {
    const { from, before } = day("2026-06-11");
    const doses = dosesInRange("Q8H", 0, course(), NY, from, before);
    // Signed 12:00Z; the day runs 04:00Z→04:00Z, so 04:00, 12:00 and 20:00Z fall inside it.
    expect(doses.map((d) => d.scheduledFor.toISOString())).toEqual([
      "2026-06-11T04:00:00.000Z",
      "2026-06-11T12:00:00.000Z",
      "2026-06-11T20:00:00.000Z",
    ]);
  });

  it("Q4H and Q6H produce the right count for a day", () => {
    const { from, before } = day("2026-06-11");
    expect(dosesInRange("Q4H", 0, course(), NY, from, before)).toHaveLength(6);
    expect(dosesInRange("Q6H", 0, course(), NY, from, before)).toHaveLength(4);
  });

  it("a course signed weeks ago still answers today cheaply and correctly", () => {
    const old = course({ signedAt: new Date("2026-01-01T12:00:00Z") });
    const { from, before } = day("2026-06-11");
    const doses = dosesInRange("Q8H", 0, old, NY, from, before);
    expect(doses).toHaveLength(3);
    // Still on the original 8-hour grid, 162 days later.
    expect(doses[0]?.scheduledFor.toISOString()).toBe("2026-06-11T04:00:00.000Z");
  });
});

describe("PRN and STAT", () => {
  it("SOS produces no slots at all — it is given on demand", () => {
    const { from, before } = day("2026-06-11");
    expect(dosesInRange("SOS", 0, course(), NY, from, before)).toEqual([]);
  });

  it("STAT is exactly one dose, at the signature, and never recurs", () => {
    const onDay = day("2026-06-10");
    expect(dosesInRange("STAT", 0, course(), NY, onDay.from, onDay.before)).toHaveLength(1);

    const nextDayRange = day("2026-06-11");
    expect(
      dosesInRange("STAT", 0, course(), NY, nextDayRange.from, nextDayRange.before),
    ).toHaveLength(0);
  });

  it("WEEKLY recurs only on the weekday the course started", () => {
    // 2026-06-10 is a Wednesday.
    const wednesday = day("2026-06-17");
    const thursday = day("2026-06-18");
    expect(dosesInRange("WEEKLY", 0, course(), NY, wednesday.from, wednesday.before)).toHaveLength(
      1,
    );
    expect(dosesInRange("WEEKLY", 0, course(), NY, thursday.from, thursday.before)).toHaveLength(0);
  });
});

describe("the course bounds the schedule", () => {
  it("nothing is due before the signature", () => {
    const { from, before } = day("2026-06-10");
    const doses = dosesInRange("TDS", 0, course(), NY, from, before);
    // Signed at 08:00; the 08:00 round is the first, the earlier rounds of that day are not due.
    expect(doses.map((d) => hourAt(d.scheduledFor, NY))).toEqual([8, 14, 20]);
    expect(doses.every((d) => d.scheduledFor >= signedAt)).toBe(true);
  });

  it("durationDays counts clinic days inclusive of the first", () => {
    // A 2-day course signed Wednesday covers Wednesday and Thursday, and stops at Friday midnight.
    const twoDays = course({ durationDays: 2 });
    const wed = day("2026-06-10");
    const thu = day("2026-06-11");
    const fri = day("2026-06-12");
    expect(dosesInRange("OD", 0, twoDays, NY, wed.from, wed.before)).toHaveLength(1);
    expect(dosesInRange("OD", 0, twoDays, NY, thu.from, thu.before)).toHaveLength(1);
    expect(dosesInRange("OD", 0, twoDays, NY, fri.from, fri.before)).toHaveLength(0);
  });

  it("a cancelled course stops at the cancellation, keeping earlier doses", () => {
    const stopped = course({ stoppedAt: new Date("2026-06-11T17:00:00Z") }); // 13:00 NY
    const { from, before } = day("2026-06-11");
    const doses = dosesInRange("TDS", 0, stopped, NY, from, before);
    // The 08:00 round happened; the 14:00 and 20:00 ones never became due.
    expect(doses.map((d) => hourAt(d.scheduledFor, NY))).toEqual([8]);
  });

  it("a window entirely outside the course is empty, not an error", () => {
    const finished = course({ durationDays: 1 });
    const { from, before } = day("2026-07-01");
    expect(dosesInRange("TDS", 0, finished, NY, from, before)).toEqual([]);
  });
});

describe("daylight saving", () => {
  /**
   * The distinction the engine exists to get right, and the reason `wallClockInZone` was added
   * rather than reusing `slots.ts`'s add-minutes-to-midnight.
   *
   * New York springs forward on 2026-03-08. A five-day course straddles it routinely.
   */
  const march = course({ signedAt: new Date("2026-03-06T13:00:00Z") }); // 08:00 EST

  it("a clock-anchored round stays at 08:00 across the spring transition", () => {
    const before1 = {
      from: new Date("2026-03-07T05:00:00Z"),
      before: new Date("2026-03-08T05:00:00Z"),
    };
    const after = {
      from: new Date("2026-03-09T04:00:00Z"),
      before: new Date("2026-03-10T04:00:00Z"),
    };

    const [pre] = dosesInRange("OD", 0, march, NY, before1.from, before1.before);
    const [post] = dosesInRange("OD", 0, march, NY, after.from, after.before);

    expect(hourAt(pre?.scheduledFor as Date, NY)).toBe(8);
    expect(hourAt(post?.scheduledFor as Date, NY)).toBe(8);
    // Same wall clock, DIFFERENT offset: 13:00Z before, 12:00Z after.
    expect(pre?.scheduledFor.toISOString()).toBe("2026-03-07T13:00:00.000Z");
    expect(post?.scheduledFor.toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });

  it("an interval-anchored frequency keeps the gap and lets the wall clock move", () => {
    const doses = dosesInRange(
      "Q8H",
      0,
      march,
      NY,
      new Date("2026-03-06T13:00:00Z"),
      new Date("2026-03-10T13:00:00Z"),
    );
    for (let i = 1; i < doses.length; i++) {
      const gap =
        (doses[i] as { scheduledFor: Date }).scheduledFor.getTime() -
        (doses[i - 1] as { scheduledFor: Date }).scheduledFor.getTime();
      expect(gap).toBe(8 * 60 * 60 * 1000);
    }
  });

  it("the autumn transition does not duplicate or drop a round", () => {
    // New York falls back on 2026-11-01.
    const nov = course({ signedAt: new Date("2026-10-30T12:00:00Z") });
    const transitionDay = {
      from: new Date("2026-11-01T04:00:00Z"),
      before: new Date("2026-11-02T05:00:00Z"),
    };
    const doses = dosesInRange("TDS", 0, nov, NY, transitionDay.from, transitionDay.before);
    expect(doses).toHaveLength(3);
    expect(doses.map((d) => hourAt(d.scheduledFor, NY))).toEqual([8, 14, 20]);
  });
});

describe("binding an administration to a slot", () => {
  const { from, before } = day("2026-06-11");
  const tds = () => dosesInRange("TDS", 0, course(), NY, from, before);

  it("charting at 14:03 binds the 14:00 round", () => {
    const bound = slotFor(tds(), new Date("2026-06-11T18:03:00Z")); // 14:03 NY
    expect(hourAt(bound?.scheduledFor as Date, NY)).toBe(14);
  });

  it("charting an hour early binds the round it is early FOR, not the one it is late after", () => {
    const bound = slotFor(tds(), new Date("2026-06-11T17:00:00Z")); // 13:00 NY
    expect(hourAt(bound?.scheduledFor as Date, NY)).toBe(14);
  });

  it("an exact tie keeps the EARLIER dose — catching up beats charting early", () => {
    // 11:00 NY is three hours from both the 08:00 and the 14:00 round.
    const bound = slotFor(tds(), new Date("2026-06-11T15:00:00Z"));
    expect(hourAt(bound?.scheduledFor as Date, NY)).toBe(8);
  });

  it("binds nothing when there are no doses at all — PRN, or a finished course", () => {
    expect(slotFor([], new Date())).toBeUndefined();
  });

  /**
   * ── THE S1 DEAD ZONE, NOW CLOSED (M3-S2) ──────────────────────────────────
   * S1 bound only within half the smaller neighbouring gap, capped at 4h. For a TDS line that is
   * 3 hours, so the overnight stretch between the 20:00 round and the next 08:00 one contained
   * instants that bound NOTHING — and an unbound row carries no `scheduledFor`, so the unique
   * index does not see it and TWO nurses could each chart the same 20:00 dose as `given`.
   *
   * That is precisely the defect S1 existed to close, displaced by six hours. These tests are the
   * regression: every instant inside an active course must bind some dose.
   */
  describe("no instant inside an active course escapes a slot", () => {
    const overnight = () => {
      const at = new Date("2026-06-12T06:00:00Z"); // 02:00 NY — six hours after the 20:00 round
      return {
        at,
        doses: dosesInRange(
          "TDS",
          0,
          course({ signedAt: new Date("2026-06-08T12:00:00Z") }),
          NY,
          new Date(at.getTime() - 24 * 60 * 60 * 1000),
          new Date(at.getTime() + 24 * 60 * 60 * 1000),
        ),
      };
    };

    it("the 02:00 back-chart binds the 20:00 round it is answering", () => {
      const { at, doses } = overnight();
      const bound = slotFor(doses, at);
      expect(bound).toBeDefined();
      expect(hourAt(bound?.scheduledFor as Date, NY)).toBe(20);
    });

    it("binds at four hours out, and at four hours and one minute out", () => {
      // The old cap sat exactly here. Both must now bind — the boundary no longer exists.
      const fourHours = slotFor(tds(), new Date("2026-06-11T16:00:00Z")); // 12:00 NY, 4h after 08:00
      const justPast = slotFor(tds(), new Date("2026-06-11T16:01:00Z"));
      expect(fourHours).toBeDefined();
      expect(justPast).toBeDefined();
      // Both are nearer the 14:00 round than the 08:00 one, and both bind rather than falling through.
      expect(hourAt(fourHours?.scheduledFor as Date, NY)).toBe(14);
      expect(hourAt(justPast?.scheduledFor as Date, NY)).toBe(14);
    });

    /**
     * The sweep that actually matters: it must cross the OVERNIGHT stretch, because that is where
     * the S1 dead zone lived. A sweep bounded by the first and last round of a single day walks
     * only the daytime gaps and passes against the broken implementation.
     */
    it("sweeps two days, overnight included, and never returns undefined", () => {
      const longCourse = course({ signedAt: new Date("2026-06-08T12:00:00Z") });
      const from = new Date("2026-06-10T04:00:00Z");
      const before = new Date("2026-06-13T04:00:00Z");
      const doses = dosesInRange("TDS", 0, longCourse, NY, from, before);

      const first = (doses[0] as { scheduledFor: Date }).scheduledFor.getTime();
      const last = (doses[doses.length - 1] as { scheduledFor: Date }).scheduledFor.getTime();
      for (let t = first; t <= last; t += 15 * 60 * 1000) {
        expect(
          slotFor(doses, new Date(t)),
          `unbound at ${new Date(t).toISOString()}`,
        ).toBeDefined();
      }
    });
  });
});
