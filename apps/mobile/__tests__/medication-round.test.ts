/**
 * The nurse medication round (M3-S5B).
 *
 * ── WHAT THIS SLICE IS, AND THEREFORE WHAT THESE TESTS DEFEND ───────────────
 * The round is a NAVIGATOR over the write S5A already proved. So the properties worth defending
 * are not "does the dose get charted" — that is `mar-administer.test.ts` — but the four ways a
 * list in front of a write goes wrong:
 *
 *   1. IT GROWS A WRITE OF ITS OWN. An inline Give, a swipe action, a "mark all given". Every
 *      safety property S5A proved would have to be proved again on a scrolling list, and the list
 *      is where the wrong patient gets the wrong drug.
 *
 *   2. IT DEVELOPS AN OPINION. Patching `state = "given"` locally after a dose instead of
 *      re-reading. The moment that opinion is wrong — and it is wrong the instant another nurse
 *      acts — the round is lying about a medication record.
 *
 *   3. ITS CACHE CONFUSES TWO WARDS, TWO BRANCHES OR TWO DAYS. Any of the three shows one set of
 *      patients' doses under another's heading.
 *
 *   4. IT HIDES WORK. A page that omits patients silently, a summary that counts only what has
 *      loaded, or an empty state that reads as "nothing due" when it means "this did not load".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoseSlot, MedicationRoundRow } from "@medicore/api-client";
import { queryKeys } from "../src/query/keys";
import { clinicalQueries } from "../src/query/clinical";
import { wardOptions } from "../src/clinical/worklist";
import { formatDayKey } from "../src/lib/time";
import {
  bedLabel,
  earliestOutstanding,
  isOutstanding,
  quietLabel,
  roundFlags,
  roundOrder,
  slotKey,
  slotOrder,
  slotRef,
  summariseRound,
  summaryLabel,
} from "../src/clinical/round";

const scope = { tenantSlug: "apollo", branchId: "branch-a" };

function slot(over: Partial<DoseSlot> = {}): DoseSlot {
  return {
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "DRUG_AMOX_500",
    drugName: "Amoxicillin 500mg",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: "2026-06-11T08:00:00.000Z",
    state: "due",
    ...over,
  };
}

function row(over: Partial<MedicationRoundRow> = {}): MedicationRoundRow {
  const slots = over.slots ?? [slot()];
  return {
    encounterId: "e1",
    patientId: "p1",
    patientName: "Ahmed Shaik",
    uhid: "P-10234",
    ward: "A Ward",
    bedCode: "A-01",
    allergens: [],
    severeAllergy: false,
    dosesDue: slots.filter(isOutstanding).length,
    dosesOverdue: slots.filter((s) => s.state === "overdue").length,
    ...over,
    slots,
  };
}

/* ── 1. medication identity ────────────────────────────────────────────────── */

describe("a dose on the round is the S1 slot, not a drug", () => {
  /**
   * The pair this exists for: paracetamol QID on the round and paracetamol SOS for breakthrough
   * fever are the SAME drug code on two lines, and they are not the same medication instruction.
   */
  it("distinguishes two lines carrying the same drug", () => {
    const regular = slot({ lineIndex: 0, drugCode: "DRUG_PARA_500" });
    const asNeeded = slot({ lineIndex: 1, drugCode: "DRUG_PARA_500" });
    expect(slotKey(regular)).not.toBe(slotKey(asNeeded));
    expect(slotRef(regular)).not.toEqual(slotRef(asNeeded));
  });

  it("distinguishes two rounds of the same line", () => {
    const morning = slot({ scheduledFor: "2026-06-11T08:00:00.000Z" });
    const evening = slot({ scheduledFor: "2026-06-11T20:00:00.000Z" });
    expect(slotKey(morning)).not.toBe(slotKey(evening));
  });

  it("distinguishes the same line on two prescriptions", () => {
    expect(slotKey(slot({ prescriptionId: "rx1" }))).not.toBe(
      slotKey(slot({ prescriptionId: "rx2" })),
    );
  });

  /**
   * What travels to the confirmation screen is the identity and NOTHING else. Carrying the drug
   * name or the state across would make the round's snapshot the basis of a clinical act; S5A
   * re-reads precisely because the world moves between the render and the tap.
   */
  it("hands on the identity alone — no drug name, no dose, no state", () => {
    expect(slotRef(slot({ state: "given", drugName: "Amoxicillin 500mg" }))).toEqual({
      prescriptionId: "rx1",
      lineIndex: 0,
      scheduledFor: "2026-06-11T08:00:00.000Z",
    });
  });

  it("gives every dose on a ward a distinct key, so no two rows collide", () => {
    const keys = [
      slot(),
      slot({ lineIndex: 1 }),
      slot({ prescriptionId: "rx2" }),
      slot({ scheduledFor: "2026-06-11T14:00:00.000Z" }),
    ].map(slotKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ── 2. the server owns the state ──────────────────────────────────────────── */

describe("dose state is read, never derived", () => {
  it("treats the server's two derived states as outstanding, and the four facts as answered", () => {
    expect(isOutstanding(slot({ state: "due" }))).toBe(true);
    expect(isOutstanding(slot({ state: "overdue" }))).toBe(true);
    for (const state of ["given", "held", "refused", "not_available"] as const) {
      expect(isOutstanding(slot({ state }))).toBe(false);
    }
  });

  /**
   * `not_available` is a state S5A deliberately does not OFFER as an action. It must still
   * RENDER: another client may have recorded it, and a round that could not display it would show
   * a dose as outstanding that the record says was answered.
   */
  it("renders not_available as answered even though the app cannot record it", () => {
    const answered = row({ slots: [slot({ state: "not_available" })] });
    expect(answered.dosesDue).toBe(0);
    expect(quietLabel(answered)).toBe("All doses answered");
  });

  it("counts from the server's numbers, not from the slots on screen", () => {
    // A row whose counts disagree with its slots is a server that changed under us; the pills read
    // the server's answer either way, because that is the one the ward's clock produced.
    const flags = roundFlags(row({ dosesDue: 3, dosesOverdue: 1, slots: [slot()] }));
    expect(flags.map((f) => f.label)).toEqual(["1 overdue", "2 due"]);
  });

  it("never double-counts an overdue dose as also due", () => {
    const flags = roundFlags(row({ dosesDue: 2, dosesOverdue: 2, slots: [] }));
    expect(flags.map((f) => f.label)).toEqual(["2 overdue"]);
  });
});

/* ── 3. triage order ───────────────────────────────────────────────────────── */

describe("the round is ordered by what is late, not by bed", () => {
  const at = (iso: string, over: Partial<MedicationRoundRow> = {}): MedicationRoundRow =>
    row({ slots: [slot({ scheduledFor: iso, state: "due" })], ...over });

  it("leads with the earliest outstanding dose", () => {
    const late = at("2026-06-11T06:00:00.000Z", { encounterId: "late", bedCode: "A-20" });
    const soon = at("2026-06-11T14:00:00.000Z", { encounterId: "soon", bedCode: "A-01" });
    expect(roundOrder([soon, late]).map((r) => r.encounterId)).toEqual(["late", "soon"]);
  });

  /**
   * S3's principle, restated: late medication must not sit behind stable patients. Ordering by the
   * earliest outstanding time gives overdue-before-due for free — an overdue dose is by definition
   * scheduled earlier — without the phone deciding which is which.
   */
  it("puts a patient with nothing outstanding last, whatever their bed", () => {
    const quiet = row({
      encounterId: "quiet",
      bedCode: "A-01",
      slots: [slot({ state: "given" })],
    });
    const due = at("2026-06-11T20:00:00.000Z", { encounterId: "due", bedCode: "A-30" });
    expect(roundOrder([quiet, due]).map((r) => r.encounterId)).toEqual(["due", "quiet"]);
  });

  it("falls back to bed order NUMERICALLY among patients with nothing due", () => {
    const bed = (code: string): MedicationRoundRow =>
      row({ encounterId: code, bedCode: code, slots: [] });
    expect(roundOrder([bed("A-10"), bed("A-2")]).map((r) => r.encounterId)).toEqual([
      "A-2",
      "A-10",
    ]);
  });

  it("does not promote a severe allergy above a late dose", () => {
    const allergic = row({
      encounterId: "allergic",
      bedCode: "A-30",
      allergens: ["penicillins"],
      severeAllergy: true,
      slots: [],
    });
    const late = at("2026-06-11T06:00:00.000Z", { encounterId: "late", bedCode: "A-01" });
    expect(roundOrder([allergic, late]).map((r) => r.encounterId)).toEqual(["late", "allergic"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row({ encounterId: "b", slots: [] }), row({ encounterId: "a", bedCode: "A-00" })];
    const before = rows.map((r) => r.encounterId);
    roundOrder(rows);
    expect(rows.map((r) => r.encounterId)).toEqual(before);
  });

  it("ignores answered doses when deciding how urgent a patient is", () => {
    const early = row({
      slots: [
        slot({ scheduledFor: "2026-06-11T06:00:00.000Z", state: "given" }),
        slot({ scheduledFor: "2026-06-11T20:00:00.000Z", state: "due" }),
      ],
    });
    expect(earliestOutstanding(early)).toBe("2026-06-11T20:00:00.000Z");
  });

  it("orders a patient's own doses by time, then stably by drug", () => {
    const ordered = slotOrder([
      slot({ scheduledFor: "2026-06-11T14:00:00.000Z", drugName: "Zzz" }),
      slot({ scheduledFor: "2026-06-11T08:00:00.000Z", drugName: "Bbb" }),
      slot({ scheduledFor: "2026-06-11T08:00:00.000Z", drugName: "Aaa" }),
    ]);
    expect(ordered.map((s) => s.drugName)).toEqual(["Aaa", "Bbb", "Zzz"]);
  });
});

/* ── 4. patient identity ───────────────────────────────────────────────────── */

describe("a medication row can never be ambiguous between two patients", () => {
  /**
   * The round endpoint resolves name and UHID server-side, unlike `/ward-worklist` which leaves
   * them to a `/bed-board` join. That is the difference between a navigation list, where a missing
   * enrichment costs a label, and a medication list, where it costs the five rights.
   */
  it("carries the name and the identifier on the row itself", () => {
    const patient = row();
    expect(patient.patientName).toBe("Ahmed Shaik");
    expect(patient.uhid).toBe("P-10234");
  });

  it("says where the patient is, and says so even when it does not know", () => {
    expect(bedLabel(row())).toBe("A Ward · A-01");
    expect(bedLabel({ ward: "A Ward" })).toBe("A Ward");
    expect(bedLabel({})).toBe("Bed not recorded");
  });

  it("names the allergens for a screen reader rather than only flagging them", () => {
    const flags = roundFlags(
      row({ allergens: ["penicillins", "sulfa"], severeAllergy: true, slots: [] }),
    );
    expect(flags.at(-1)?.accessibilityLabel).toBe("Severe allergy recorded: penicillins, sulfa");
  });

  it("states every flag in WORDS, never in tone alone", () => {
    const flags = roundFlags(
      row({ dosesDue: 2, dosesOverdue: 1, allergens: ["penicillins"], slots: [] }),
    );
    for (const flag of flags) {
      expect(flag.label.length).toBeGreaterThan(0);
      expect(flag.accessibilityLabel.length).toBeGreaterThan(flag.label.length);
    }
  });
});

/* ── 5. empty is not the same as error ─────────────────────────────────────── */

describe("the four ways a row can be quiet are four different sentences", () => {
  it("distinguishes 'nothing scheduled' from 'all answered'", () => {
    expect(quietLabel(row({ slots: [] }))).toBe("No scheduled doses today");
    expect(quietLabel(row({ slots: [slot({ state: "given" })] }))).toBe("All doses answered");
  });

  it("says nothing when there is work outstanding — the doses speak for themselves", () => {
    expect(quietLabel(row({ slots: [slot({ state: "due" })] }))).toBeUndefined();
  });

  /** A held dose is answered. The round must not keep offering it. */
  it("treats a held or refused dose as answered, not as outstanding", () => {
    expect(quietLabel(row({ slots: [slot({ state: "held" }), slot({ state: "refused" })] }))).toBe(
      "All doses answered",
    );
  });
});

/* ── 6. the summary cannot overstate what it has seen ──────────────────────── */

describe("a paged round says so rather than summarising a page as a ward", () => {
  const due = (n: number): MedicationRoundRow => row({ dosesDue: n, dosesOverdue: 0, slots: [] });

  it("adds up only the patients it has, and knows when that is not all of them", () => {
    const summary = summariseRound([due(2), due(1)], 9);
    expect(summary).toMatchObject({ patients: 2, due: 3, complete: false });
    expect(summaryLabel(summary)).toContain("of more patients loaded");
  });

  it("claims completeness only when the page count reaches the server's total", () => {
    expect(summariseRound([due(2)], 1).complete).toBe(true);
    expect(summariseRound([due(2)], undefined).complete).toBe(true);
  });

  it("counts overdue separately, and only mentions it when there is some", () => {
    expect(
      summaryLabel(summariseRound([row({ dosesDue: 3, dosesOverdue: 2, slots: [] })], 1)),
    ).toContain("2 overdue");
    expect(summaryLabel(summariseRound([due(3)], 1))).not.toContain("overdue");
  });

  it("says 'nothing outstanding', which is a fact, rather than showing a blank", () => {
    expect(summaryLabel(summariseRound([due(0)], 1))).toContain("Nothing outstanding");
  });
});

/* ── 7. the ward picker always has a way out ───────────────────────────────── */

describe("choosing a ward", () => {
  /**
   * The defect this fixes: the options were derived from rows that are themselves filtered by the
   * selection, so picking a ward collapsed the list to one entry, the bar hid itself, and there
   * was no way back to "All wards" without restarting the app.
   */
  it("keeps the chosen ward in the list even when the rows are filtered to it", () => {
    expect(wardOptions([{ ward: "A Ward" }], "A Ward")).toEqual(["A Ward"]);
    expect(wardOptions([], "A Ward")).toEqual(["A Ward"]);
  });

  it("offers every ward the server has actually returned, sorted, without duplicates", () => {
    expect(
      wardOptions([{ ward: "B Ward" }, { ward: "A Ward" }, { ward: "A Ward" }, {}], undefined),
    ).toEqual(["A Ward", "B Ward"]);
  });
});

/* ── 8. cache keys ─────────────────────────────────────────────────────────── */

describe("round query keys", () => {
  const api = {} as never;
  const keyFor = (branchId: string, filter: { ward?: string; date: string }): string =>
    JSON.stringify(
      clinicalQueries(api, { tenantSlug: "apollo", branchId }).medicationRound(filter).queryKey,
    );

  const TODAY = "2026-06-11";

  it("gives two wards two cache entries", () => {
    expect(keyFor("branch-a", { ward: "A Ward", date: TODAY })).not.toBe(
      keyFor("branch-a", { ward: "B Ward", date: TODAY }),
    );
  });

  /** The one that shows yesterday's answered doses as today's outstanding work. */
  it("gives two days two cache entries", () => {
    expect(keyFor("branch-a", { ward: "A Ward", date: TODAY })).not.toBe(
      keyFor("branch-a", { ward: "A Ward", date: "2026-06-10" }),
    );
  });

  it("gives the same ward at two branches two cache entries", () => {
    expect(keyFor("branch-a", { ward: "A Ward", date: TODAY })).not.toBe(
      keyFor("branch-b", { ward: "A Ward", date: TODAY }),
    );
  });

  it("distinguishes one ward from the whole branch", () => {
    expect(keyFor("branch-a", { ward: "A Ward", date: TODAY })).not.toBe(
      keyFor("branch-a", { date: TODAY }),
    );
  });

  /** Same ward, different questions: counts-and-flags versus the doses themselves. */
  it("never collides with the ward worklist, the schedule or the MAR record", () => {
    const keys = [
      queryKeys.medicationRound(scope, "date=2026-06-11&limit=40"),
      queryKeys.wardWorklist(scope, "limit=40"),
      queryKeys.medicationSchedule(scope, "e1"),
      queryKeys.medications(scope, "e1"),
      queryKeys.inpatients(scope, "limit=40"),
      queryKeys.bedBoard(scope),
    ].map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("begins with the tenant and the branch, like every other clinical key", () => {
    expect(queryKeys.medicationRound(scope, "x").slice(0, 2)).toEqual(["apollo", "branch-a"]);
  });

  /** The round changes nothing about allergies, which are read hospital-wide (S3/S4/S5A). */
  it("leaves the allergy key hospital-wide, with no scope segment of any kind", () => {
    expect(queryKeys.patientAllergies("apollo", "p1")).toEqual([
      "apollo",
      "patient",
      "p1",
      "allergies",
    ]);
  });
});

/* ── 9. the request the round makes ────────────────────────────────────────── */

describe("the round is one request per page, and it asks for the right thing", () => {
  function capture(filter: { ward?: string; date: string }) {
    const calls: unknown[] = [];
    const api = {
      listMedicationRound: (params: unknown) => {
        calls.push(params);
        return Promise.resolve({ items: [], meta: { page: 1, limit: 40, total: 0 } });
      },
    } as never;
    const read = clinicalQueries(api, scope).medicationRound(filter);
    return { read, calls };
  }

  it("sends the ward and the day to the SERVER, and pages", async () => {
    const { read, calls } = capture({ ward: "A Ward", date: "2026-06-11" });
    await read.queryFn({ pageParam: 2 });
    expect(calls[0]).toMatchObject({ ward: "A Ward", date: "2026-06-11", page: 2 });
  });

  it("omits the ward rather than sending an empty filter for 'all wards'", async () => {
    const { read, calls } = capture({ date: "2026-06-11" });
    await read.queryFn({ pageParam: 1 });
    expect(calls[0]).not.toHaveProperty("ward");
  });

  /**
   * ── THE N+1 THIS ENDPOINT EXISTS TO PREVENT ───────────────────────────────
   * The round descriptor must be a SINGLE call. If it ever grew a per-patient schedule read, a
   * twenty-bed ward would cost twenty-one requests on hospital wifi — the exact shape S3 removed.
   */
  it("makes exactly one call per page, whatever the ward contains", async () => {
    const { read, calls } = capture({ date: "2026-06-11" });
    await read.queryFn({ pageParam: 1 });
    expect(calls).toHaveLength(1);
  });

  it("stops paging when the server says there is no more", () => {
    const { read } = capture({ date: "2026-06-11" });
    expect(read.getNextPageParam({ items: [], meta: { page: 1, limit: 40, hasMore: false } })).toBe(
      undefined,
    );
    expect(read.getNextPageParam({ items: [], meta: { page: 1, limit: 40, hasMore: true } })).toBe(
      2,
    );
  });
});

/* ── 10. the clinical day is the ward's ────────────────────────────────────── */

describe("which day the round is", () => {
  /**
   * ── THE MIDNIGHT CASE, WHICH IS THE ONLY ONE THAT MATTERS ─────────────────
   * 23:30 on 11 June in Delhi is 14:00 on 11 June in New York, and 00:30 on 12 June in Delhi is
   * still 15:00 on the 11th in New York. A round keyed on the device's day would roll over at the
   * reader's midnight and show an empty ward — or worse, tomorrow's empty schedule — while the
   * night shift was still working.
   */
  it("follows the branch's zone across the device's midnight", () => {
    const justBefore = new Date("2026-06-11T18:29:00.000Z"); // 23:59 IST, 14:29 in New York
    const justAfter = new Date("2026-06-11T18:31:00.000Z"); // 00:01 IST on the 12th

    expect(formatDayKey(justBefore, "Asia/Kolkata")).toBe("2026-06-11");
    expect(formatDayKey(justAfter, "Asia/Kolkata")).toBe("2026-06-12");

    // The ward's day does not move.
    expect(formatDayKey(justBefore, "America/New_York")).toBe("2026-06-11");
    expect(formatDayKey(justAfter, "America/New_York")).toBe("2026-06-11");
  });

  it("and across the ward's own midnight, which is when the round DOES roll over", () => {
    expect(formatDayKey(new Date("2026-06-12T03:59:00.000Z"), "America/New_York")).toBe(
      "2026-06-11",
    );
    expect(formatDayKey(new Date("2026-06-12T04:01:00.000Z"), "America/New_York")).toBe(
      "2026-06-12",
    );
  });
});

/* ── 11. structural ────────────────────────────────────────────────────────── */

describe("what the round may not contain", () => {
  const read = (path: string): string =>
    readFileSync(join(__dirname, "..", path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const model = read("src/clinical/round.ts");
  const screen = read("app/round.tsx");

  it("reads the files it is scanning", () => {
    expect(model.length).toBeGreaterThan(500);
    expect(screen.length).toBeGreaterThan(500);
  });

  /**
   * ── CONTROL 1 / 2 / 26: NO WRITE PATH ON THE LIST ─────────────────────────
   * The round navigates. The only screen that charts a dose is the S5A confirmation, and the only
   * way this file may reach the MAR is by pushing to it. A `mutations.administerDose`, a
   * `useClinicalWrite`, or a direct `recordMedicationAdministration` here would be a second write
   * path — and it would be a second write path on a scrolling list.
   */
  it("performs no clinical write of its own", () => {
    for (const [source, name] of [
      [model, "src/clinical/round.ts"],
      [screen, "app/round.tsx"],
    ] as const) {
      for (const forbidden of [
        /useClinicalWrite\s*\(/,
        /administerDose\s*\(/,
        /recordMedicationAdministration\s*\(/,
        /useClinicalMutations\s*\(/,
        /\.mutate\s*\(/,
      ]) {
        expect(forbidden.test(source), `${name} matches ${String(forbidden)}`).toBe(false);
      }
    }
  });

  /** …and reaches the write only by handing the S5A screen a slot identity. */
  it("reaches the medication record only through the S5A confirmation screen", () => {
    expect(screen).toMatch(/pathname:\s*"\/administer\/\[encounterId\]"/);
    expect(screen).toMatch(/prescriptionId:\s*slot\.prescriptionId/);
    expect(screen).toMatch(/scheduledFor:\s*slot\.scheduledFor/);
  });

  /** ── CONTROL 27: no bulk administration, in any of its disguises. */
  it("offers no bulk, quick or swipe administration", () => {
    for (const forbidden of [/giveAll/i, /markAll/i, /quickGive/i, /onSwipe/i, /selectedSlots/i]) {
      expect(forbidden.test(screen)).toBe(false);
    }
  });

  /**
   * ── CONTROL 7: THE ROUND NEVER PATCHES ITS OWN COPY ───────────────────────
   * After a dose is charted the round re-reads. `setQueryData` — or any local assignment of a
   * slot state — would give the list an opinion the database never agreed to, and the first time
   * that opinion is wrong somebody gives a second dose.
   */
  it("writes no clinical state into the cache and mutates no slot locally", () => {
    for (const source of [model, screen]) {
      expect(/setQueryData/.test(source)).toBe(false);
      // `=` NOT followed by `=` — an assignment. The first form of this matched `state === "due"`
      // and would have passed against a file that assigned states all day long.
      expect(/\.state\s*=[^=]/.test(source)).toBe(false);
      expect(/state:\s*["'](given|held|refused|not_available)["']/.test(source)).toBe(false);
    }
  });

  /**
   * ── CONTROL 6: NO LOCAL DUE/OVERDUE ARITHMETIC ────────────────────────────
   * Whether a dose is late is a question about the WARD's clock and real administration rows. The
   * model may compare two `scheduledFor` strings to order the list — that is presentation — but it
   * must never read a clock to decide a state.
   */
  it("reads no clock in the round model", () => {
    for (const forbidden of [
      /Date\.now\s*\(/,
      /new Date\s*\(\s*\)/,
      /performance\.now\s*\(/,
      /OVERDUE/,
    ]) {
      expect(forbidden.test(model), `round.ts matches ${String(forbidden)}`).toBe(false);
    }
  });

  it("derives no due or overdue state of its own", () => {
    // The only comparison against a state literal is against the SERVER's own vocabulary.
    const comparisons = [...model.matchAll(/state\s*===\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(comparisons.sort()).toEqual(["due", "overdue"]);
  });

  /**
   * ── CONTROL 8: the DAY comes from the branch's zone ───────────────────────
   * `formatDayKey(now, zone)` where `zone` came from `useZoneFor` — never a bare day derived from
   * the handset. The device-clock scan in `routes.test.ts` covers `toLocaleDateString` and
   * friends; this pins the positive form, which that scan cannot see.
   */
  it("takes the clinical day from the branch's zone", () => {
    expect(screen).toMatch(/useZoneFor\s*\(/);
    expect(screen).toMatch(/formatDayKey\s*\(\s*now\s*,\s*zone\s*\)/);
  });

  /** ── CONTROL 12: nothing reaches the network except through the ApiClient. */
  it("never bypasses the api-client", () => {
    for (const source of [model, screen]) {
      expect(/\bfetch\s*\(/.test(source)).toBe(false);
      expect(/api\/v1/.test(source)).toBe(false);
    }
  });

  /**
   * ── CONTROL 9: NO PER-PATIENT FAN-OUT ─────────────────────────────────────
   * The whole reason `/medication-round` exists. A `queries.medicationSchedule(...)` or a
   * `queries.allergies(...)` on this screen would be a request per bed — the N+1 S3 removed.
   */
  it("makes no per-patient request", () => {
    for (const forbidden of [
      /medicationSchedule\s*\(/,
      /queries\.allergies\s*\(/,
      /queries\.patient\s*\(/,
      /queries\.encounter\s*\(/,
      /bedBoard\s*\(/,
    ]) {
      expect(forbidden.test(screen), `app/round.tsx matches ${String(forbidden)}`).toBe(false);
    }
  });

  it("reads the round, and nothing else clinical", () => {
    const reads = [...screen.matchAll(/queries\.(\w+)\s*\(/g)].map((m) => m[1]);
    expect([...new Set(reads)]).toEqual(["medicationRound"]);
  });

  /**
   * ── CONTROL 11: allergies are context, never a decision ───────────────────
   * There is no drug-allergy engine in this product. The round lists what is recorded beside the
   * drugs and says nothing about the relationship between them.
   */
  it("never calls a drug safe and never matches drugs against allergies", () => {
    for (const source of [model, screen]) {
      expect(/\bsafe\b/i.test(source)).toBe(false);
      expect(/allergen.*(includes|some|match)|(?:includes|match).*allergen/i.test(source)).toBe(
        false,
      );
    }
  });

  it("does not filter allergies by branch — they are hospital-wide", () => {
    for (const source of [model, screen]) {
      expect(/allerg\w*[\s\S]{0,40}branch/i.test(source)).toBe(false);
    }
  });

  /** The round is gated on what the SERVER requires, and offers actions only to who may act. */
  it("gates the screen on the permission the endpoint actually enforces", () => {
    expect(screen).toMatch(/can\("emr:read"\)/);
    expect(screen).toMatch(/can\("mar:administer"\)/);
  });

  /** A feature the hospital did not buy is not an empty ward. */
  it("distinguishes an unavailable module from a ward with nobody in it", () => {
    expect(screen).toMatch(/isFeatureUnavailable/);
    expect(screen).toMatch(/Not in this edition/);
    expect(screen).toMatch(/Nobody admitted/);
  });

  /** An error is not an empty round: `QueryGate` renders the three states or none of them. */
  it("routes loading, error and empty through the one gate", () => {
    expect(screen).toMatch(/<QueryGate/);
    expect(screen).toMatch(/error=\{round\.error\}/);
    expect(screen).toMatch(/loading=\{round\.isPending/);
  });

  /** Refreshing after a dose must not blank the ward mid-round. */
  it("refreshes without destroying what is on screen", () => {
    expect(screen).toMatch(/refreshing=\{round\.isRefetching\}/);
  });
});
