/**
 * THE CLINICAL DOMAIN — the rules that decide what a doctor is shown, tested without a renderer.
 *
 * These are the assertions worth defending: a result that must not be visible yet, a colour that
 * must mean one thing, an ordering that must not bury a panic value, and a clock that must not
 * follow the phone. All of them live in `src/clinical`, which imports no React and no React Native
 * (enforced by dependency-cruiser), so all of them run in Node.
 */
import { describe, expect, it } from "vitest";
import {
  encounterClassLabel,
  encounterStatusLabel,
  encounterStatusTone,
  isLiveEncounter,
  sortForRound,
  summariseRound,
} from "../src/clinical/encounters";
import { bloodPressure, latestReading, vitalRows } from "../src/clinical/vitals";
import {
  isCriticalResult,
  isCriticalValue,
  isOutstanding,
  isResultReadable,
  orderStatusLabel,
  sortForReview,
  summariseResults,
  valueTone,
} from "../src/clinical/results";
import { buildTimeline } from "../src/clinical/timeline";
import { ageInYears, demographics, isSupersededRecord } from "../src/clinical/patient";
import { zoneForRecord, zoneResolver } from "../src/clinical/zone";
import { formatDateTime, formatDayKey, formatRelativeDay, formatTime } from "../src/lib/time";
import {
  consultationNote,
  criticalOrder,
  encounter,
  order,
  patient,
  prescription,
  vitals,
} from "./support/fixtures";

/* ════════════════════════════════════════════════════════════════════════════
 * 7 · 9 · 10 — RESULTS: what may be seen, and what must be shouted about
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a result is invisible until it is released", () => {
  /**
   * The three rungs exist for a reason: `completed` is a machine's number, `verified` is a second
   * person's check, `released` is permission to act (STATE_MACHINE_CATALOG §15). A UI that renders
   * `result` the moment the field appears deletes the second pair of eyes silently.
   */
  it.each(["placed", "accepted", "in_progress", "completed", "verified"] as const)(
    "hides the values at %s, even when the payload already carries them",
    (status) => {
      const withResult = criticalOrder({ status });
      expect(withResult.result).toBeDefined();
      expect(isResultReadable(withResult)).toBe(false);
      // …and the alarm is suppressed too. A red banner on an unverified number is worse than none:
      // it pushes a clinician to act, and it devalues every real one.
      expect(isCriticalResult(withResult)).toBe(false);
    },
  );

  it("shows them at released", () => {
    const released = criticalOrder();
    expect(isResultReadable(released)).toBe(true);
    expect(isCriticalResult(released)).toBe(true);
  });

  it("says what is being waited FOR, not what the lab has done", () => {
    // "Completed" on a doctor's screen reads as "there is a number for me", and there is not one.
    expect(orderStatusLabel("completed")).toBe("Awaiting verification");
    expect(orderStatusLabel("verified")).toBe("Awaiting release");
    expect(orderStatusLabel("released")).toBe("Result ready");
  });
});

describe("critical is the server's word", () => {
  it("reads `result.critical` and never a range of its own", () => {
    // The same numbers, not flagged by the lab: nothing here re-derives criticality from 7.1.
    const notFlagged = criticalOrder({
      result: {
        summary: "Potassium 7.1 mmol/L",
        values: [{ code: "K", label: "Potassium", value: "7.1", unit: "mmol/L" }],
      },
    });
    expect(isCriticalResult(notFlagged)).toBe(false);
    expect(isCriticalResult(criticalOrder())).toBe(true);
  });

  it("matches the lab's flag strings case-insensitively — `flag` is free text on the contract", () => {
    expect(isCriticalValue("critical_high")).toBe(true);
    expect(isCriticalValue("CRITICAL_LOW")).toBe(true);
    expect(isCriticalValue("high")).toBe(false);
    expect(isCriticalValue(undefined)).toBe(false);
  });

  it("spends the critical tone on nothing else", () => {
    expect(valueTone("critical_high")).toBe("critical");
    // Abnormal but not critical is a warning. If four things are red, nothing is.
    expect(valueTone("high")).toBe("warning");
    expect(valueTone("normal")).toBe("neutral");
    expect(valueTone(undefined)).toBe("neutral");
  });
});

describe("a panic value is not buried under six routine results", () => {
  it("sorts critical, then outstanding, then the rest — newest first inside each", () => {
    const list = [
      order({
        id: "old-released",
        status: "released",
        orderedAt: "2026-08-01T04:00:00.000Z",
        result: {},
      }),
      order({ id: "waiting-new", status: "in_progress", orderedAt: "2026-08-12T09:00:00.000Z" }),
      criticalOrder({ id: "panic", orderedAt: "2026-08-12T04:00:00.000Z" }),
      order({ id: "waiting-old", status: "placed", orderedAt: "2026-08-11T04:00:00.000Z" }),
    ];

    expect(sortForReview(list).map((o) => o.id)).toEqual([
      "panic",
      "waiting-new",
      "waiting-old",
      "old-released",
    ]);
  });

  it("counts what is still out, and what came back flagged", () => {
    const summary = summariseResults([
      order({ id: "a", status: "placed" }),
      order({ id: "b", status: "verified" }),
      criticalOrder(),
      order({ id: "c", status: "cancelled" }),
    ]);
    // `verified` is still outstanding from the doctor's side — the number has not been released.
    expect(summary).toEqual({ outstanding: 2, critical: 1 });
    expect(isOutstanding(order({ status: "cancelled" }))).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8 — VITALS: the server's ranges, the server's flags
 * ══════════════════════════════════════════════════════════════════════════ */

describe("vitals are rendered, never re-assessed", () => {
  it("carries every present measurement with its unit, in chart order", () => {
    const rows = vitalRows(vitals());
    expect(rows.map((r) => r.field)).toEqual([
      "systolic",
      "diastolic",
      "pulse",
      "temperature",
      "spo2",
    ]);
    expect(rows.find((r) => r.field === "temperature")).toMatchObject({
      label: "Temperature",
      value: "37.4",
      unit: "°C",
    });
    // Every row has a unit. A number without one is the oldest medication error there is.
    expect(rows.every((row) => row.unit.length > 0)).toBe(true);
  });

  it("omits what was not measured rather than showing a dash", () => {
    const rows = vitalRows(vitals({ pulse: undefined, spo2: undefined }));
    expect(rows.map((r) => r.field)).not.toContain("pulse");
    expect(rows.map((r) => r.field)).not.toContain("spo2");
  });

  it("takes the flag from the payload and derives none", () => {
    // The server called a systolic of 148 high and a pulse of 88 normal. Both are echoed as given;
    // no threshold appears anywhere in this module.
    const rows = vitalRows(vitals());
    expect(rows.find((r) => r.field === "systolic")?.tone).toBe("warning");
    expect(rows.find((r) => r.field === "pulse")?.tone).toBe("neutral");

    // …and when the SERVER changes its mind, so does the phone, with no code change.
    const relaxed = vitalRows(vitals({ flags: { systolic: "normal" } }));
    expect(relaxed.find((r) => r.field === "systolic")?.tone).toBe("neutral");
  });

  it("never spends the critical tone on an observation", () => {
    // Advisory only, says the contract. `criticalClinical` belongs to released results alone.
    expect(vitalRows(vitals()).every((row) => row.tone !== "critical")).toBe(true);
  });

  it("pairs blood pressure, and refuses to pair half of it", () => {
    expect(bloodPressure(vitals())).toBe("148/92 mmHg");
    expect(bloodPressure(vitals({ diastolic: undefined }))).toBeUndefined();
  });

  it("finds the latest by timestamp, not by array position", () => {
    /**
     * The two endpoints document OPPOSITE orders — `listPatientVitals` newest first,
     * `listEncounterVitals` oldest first. A helper that trusted the order would show the oldest
     * observation as "latest" on exactly one of the two screens, which is the kind of bug that
     * only shows up in front of a patient.
     */
    const older = vitals({ id: "v-old", recordedAt: "2026-08-12T01:00:00.000Z" });
    const newer = vitals({ id: "v-new", recordedAt: "2026-08-12T09:00:00.000Z" });
    expect(latestReading([older, newer])?.id).toBe("v-new");
    expect(latestReading([newer, older])?.id).toBe("v-new");
    expect(latestReading([])).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The round: order, status wording, counts
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the doctor's list is worked in an order the waiting room accepts", () => {
  it("puts the person in the room first, then express, then token order", () => {
    const list = [
      encounter({ id: "c", token: 30 }),
      encounter({ id: "a", token: 40, status: "in_progress" }),
      encounter({ id: "b", token: 50, express: true }),
      encounter({ id: "d", token: 10, status: "closed" }),
    ];
    expect(sortForRound(list).map((e) => e.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("sorts a patient with no token AFTER those who have one, not to the top", () => {
    const list = [encounter({ id: "none", token: undefined }), encounter({ id: "t5", token: 5 })];
    expect(sortForRound(list).map((e) => e.id)).toEqual(["t5", "none"]);
  });

  it("does not mutate the list it was given", () => {
    const list = [encounter({ id: "b", token: 9 }), encounter({ id: "a", token: 1 })];
    sortForRound(list);
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("counts the day without a second request", () => {
    expect(
      summariseRound([
        encounter({ id: "1", status: "in_queue" }),
        encounter({ id: "2", status: "arrived" }),
        encounter({ id: "3", status: "in_progress" }),
        encounter({ id: "4", status: "awaiting_results" }),
        encounter({ id: "5", status: "closed" }),
      ]),
    ).toEqual({ total: 5, waiting: 2, inProgress: 1, awaitingResults: 1 });
  });

  it("does not soften `left_without_being_seen` into a cancellation", () => {
    // A patient who gave up and went home is a governance event, not an administrative one.
    expect(encounterStatusLabel("left_without_being_seen")).toBe("Left without being seen");
    expect(encounterStatusTone("left_without_being_seen")).toBe("warning");
    expect(encounterStatusLabel("cancelled")).toBe("Cancelled");
  });

  it("knows which visits are still live", () => {
    expect(isLiveEncounter({ status: "awaiting_results" })).toBe(true);
    expect(isLiveEncounter({ status: "closed" })).toBe(false);
    expect(encounterClassLabel("IP")).toBe("Inpatient");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7 — THE TIMELINE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the timeline is assembled from what the API actually says", () => {
  it("merges four sources newest first", () => {
    const events = buildTimeline({
      encounters: [encounter()],
      orders: [order(), criticalOrder()],
      prescriptions: [prescription()],
      vitals: [vitals()],
      notes: [consultationNote()],
    });

    expect(events.map((e) => e.kind)).toEqual([
      "result", // 05:20 — released
      "prescription", // 04:31
      "note", // 04:20
      "order", // 04:00 (the critical order was RAISED at 04:00 too; id breaks the tie)
      "order",
      "vitals", // 03:45
      "visit", // 03:30
    ]);
  });

  it("splits an order into ASKED and ANSWERED, dated separately", () => {
    /**
     * They are days apart in practice, and collapsing them into one row dated at the request loses
     * the only date a doctor chasing a result cares about.
     */
    const events = buildTimeline({ orders: [criticalOrder()] });
    const asked = events.find((e) => e.kind === "order");
    const answered = events.find((e) => e.kind === "result");
    expect(asked?.at).toBe("2026-08-12T04:00:00.000Z");
    expect(answered?.at).toBe("2026-08-12T05:20:00.000Z");
    // The result event is dated at RELEASE, not at completion — when a clinician could see it.
    expect(answered?.at).not.toBe("2026-08-12T05:00:00.000Z");
    expect(answered?.critical).toBe(true);
  });

  it("produces no result event at all while the order is unreleased", () => {
    const events = buildTimeline({ orders: [criticalOrder({ status: "verified" })] });
    expect(events.map((e) => e.kind)).toEqual(["order"]);
  });

  it("keeps an unsigned prescription off the record", () => {
    // A draft binds nobody and may never be signed. On a chart it would read as a medication the
    // patient is taking.
    const draft = prescription({ status: "draft", signedAt: undefined });
    expect(buildTimeline({ prescriptions: [draft] })).toEqual([]);
    expect(buildTimeline({ prescriptions: [prescription()] })).toHaveLength(1);
  });

  it("carries each event's own branch, so a mixed list can be stamped per site", () => {
    const events = buildTimeline({
      encounters: [encounter({ branchId: "branch-chn" })],
      orders: [order({ branchId: "branch-hyd" })],
    });
    expect(events.map((e) => e.branchId).sort()).toEqual(["branch-chn", "branch-hyd"]);
  });

  it("is totally ordered, so the list cannot flicker between renders", () => {
    const at = "2026-08-12T04:00:00.000Z";
    const first = buildTimeline({
      orders: [order({ id: "b", orderedAt: at }), order({ id: "a", orderedAt: at })],
    });
    const second = buildTimeline({
      orders: [order({ id: "a", orderedAt: at }), order({ id: "b", orderedAt: at })],
    });
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
  });

  it("invents nothing from an empty chart", () => {
    expect(buildTimeline({})).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * IDENTITY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("identity is a safety control", () => {
  it("computes age from calendar parts, not from elapsed milliseconds", () => {
    // The day before a birthday and the day of it — the boundary a /365.25 division gets wrong.
    expect(ageInYears("1991-04-02", new Date("2026-04-01T12:00:00.000Z"))).toBe(34);
    expect(ageInYears("1991-04-02", new Date("2026-04-02T12:00:00.000Z"))).toBe(35);
  });

  it("returns nothing rather than 0 for a date it cannot read", () => {
    // "0 y" on a chart reads as a newborn, which is a dangerous thing to print about an adult.
    expect(ageInYears(undefined)).toBeUndefined();
    expect(ageInYears("")).toBeUndefined();
    expect(ageInYears("02/04/1991")).toBeUndefined();
    expect(ageInYears("2999-01-01", new Date("2026-08-12T00:00:00.000Z"))).toBeUndefined();
  });

  it("still states the sex when the date of birth is missing", () => {
    expect(demographics(patient(), new Date("2026-08-12T00:00:00.000Z"))).toBe("35 y · F");
    expect(demographics(patient({ dob: undefined }))).toBe("F");
  });

  it("flags a merged record, which otherwise reads perfectly", () => {
    expect(isSupersededRecord(patient())).toBe(false);
    expect(isSupersededRecord(patient({ status: "merged" }))).toBe(true);
    expect(isSupersededRecord(patient({ mergedInto: "patient-9" }))).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 11 — TIMEZONE: UTC → branch zone → display. Never the device.
 * ══════════════════════════════════════════════════════════════════════════ */

const BRANCHES = [
  { id: "branch-hyd", timezone: "Asia/Kolkata" },
  { id: "branch-lon", timezone: "Europe/London" },
  { id: "branch-broken", timezone: "IST" },
  { id: "branch-none" },
];

describe("11. a clinical timestamp renders in the branch's zone", () => {
  const at = new Date("2026-08-12T03:30:00.000Z"); // 09:00 IST, 04:30 BST

  it("uses the RECORD's branch, not the reader's selection", () => {
    /**
     * The clinically correct answer, and the reason this is per-record rather than per-screen: a
     * result released at 04:30 in London reads as 04:30 to everyone, whoever is looking and
     * whichever site they have selected.
     */
    const zone = zoneForRecord(BRANCHES, "branch-lon", "branch-hyd");
    expect(zone).toBe("Europe/London");
    expect(formatTime(at, { zone, labelled: false })).toBe("04:30");
    expect(formatTime(at, { zone: "Asia/Kolkata", labelled: false })).toBe("09:00");
  });

  it("falls back to the active branch when the record names none", () => {
    // Pre-branch rows carry no `branchId`. The reader's site is the best available answer.
    expect(zoneForRecord(BRANCHES, undefined, "branch-lon")).toBe("Europe/London");
  });

  it("falls back to the platform default, and NEVER to the device", () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resolved = zoneForRecord([], undefined, undefined);
    expect(resolved).toBe("Asia/Kolkata");
    // Stated as a property rather than as a literal: whatever this machine is set to, the answer
    // is the platform default unless the machine happens to BE the platform default.
    if (device !== "Asia/Kolkata") expect(resolved).not.toBe(device);
  });

  it("ignores a branch id that is not in the VALIDATED list", () => {
    /**
     * A `branchId` off an API response is a lookup key here and nothing more. One that is not in
     * the list `/me/branches` returned resolves to nothing and falls through — so the worst a
     * tampered or unknown id can do is move a printed time to the fallback zone.
     */
    expect(zoneForRecord(BRANCHES, "branch-someone-elses", "branch-lon")).toBe("Europe/London");
  });

  it("survives a branch whose zone the hospital typed wrongly", () => {
    // `IST` is storable on older servers and makes `Intl` resolve to Asia/Calcutta silently — or
    // throw, for a real typo. Either way a ward list must not crash over a settings field.
    expect(zoneForRecord(BRANCHES, "branch-broken", "branch-lon")).toBe("Europe/London");
    expect(zoneForRecord(BRANCHES, "branch-broken", undefined)).toBe("Asia/Kolkata");
    expect(() =>
      formatDateTime(at, zoneForRecord(BRANCHES, "branch-broken", undefined)),
    ).not.toThrow();
  });

  it("resolves per row, so one list can span sites", () => {
    const resolve = zoneResolver(BRANCHES, "branch-hyd");
    expect(resolve("branch-lon")).toBe("Europe/London");
    expect(resolve("branch-hyd")).toBe("Asia/Kolkata");
    expect(resolve(undefined)).toBe("Asia/Kolkata");
  });
});

describe("11b. a branch in a different zone from this machine", () => {
  /**
   * ── THE CONTROL THIS SUITE NEEDS, WRITTEN SO IT CANNOT PASS BY LUCK ─────────
   * A test that hard-codes one zone proves nothing on a CI box that happens to be set to it. So
   * the far zone is CHOSEN against the machine's own: Pacific/Kiritimati is UTC+14 and
   * Europe/London is UTC+0/+1, and no machine can be in both. The rendered output is then asserted
   * to differ from the device rendering — which is exactly what would break if any of this ever
   * started calling `toLocaleTimeString()`.
   */
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const far = device.startsWith("Pacific/") ? "Europe/London" : "Pacific/Kiritimati";
  const at = new Date("2026-08-12T18:00:00.000Z");

  it("differs from the device zone, and follows the branch", () => {
    const branches = [{ id: "branch-far", timezone: far }];
    const zone = zoneForRecord(branches, "branch-far", undefined);
    expect(zone).toBe(far);

    const shown = formatDateTime(at, zone);
    const deviceRendering = formatDateTime(at, device);
    expect(shown).not.toBe(deviceRendering);
  });

  it("crosses the DAY boundary in the branch's zone, not the machine's", () => {
    /**
     * 18:00 UTC is the 13th in Kiritimati (+14) and the 12th nearly everywhere else. The day key
     * is what `?date=` is built from, so getting this from the device is how a doctor abroad asks
     * the hospital for yesterday's register and is told, accurately, that nobody is waiting.
     */
    expect(formatDayKey(at, "Pacific/Kiritimati")).toBe("2026-08-13");
    expect(formatDayKey(at, "Europe/London")).toBe("2026-08-12");
    expect(formatDayKey(at, "UTC")).toBe("2026-08-12");
  });

  it("labels Today and Yesterday against the branch's clock", () => {
    const now = new Date("2026-08-12T18:00:00.000Z");
    // The same instant is "Today" in London and, in Kiritimati where it is already the 13th,
    // yesterday's events are the ones from the 12th.
    expect(formatRelativeDay(now, "Europe/London", now)).toBe("Today");
    expect(formatRelativeDay(new Date("2026-08-11T18:00:00.000Z"), "Europe/London", now)).toBe(
      "Yesterday",
    );
    expect(formatRelativeDay(now, "Pacific/Kiritimati", now)).toBe("Today");
    expect(formatRelativeDay(new Date("2026-08-01T18:00:00.000Z"), "Europe/London", now)).toBe(
      "01 Aug 2026",
    );
  });
});
