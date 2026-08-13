/**
 * The nurse's worklist and chart (M3-S3).
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────────
 * Two properties, both of which are the reason the slice exists:
 *
 *   1. THE PHONE DECIDES NOTHING CLINICAL. `due` and `overdue` come from the server, resolved in
 *      the branch's timezone. This suite proves the mobile code SORTS and LABELS them and never
 *      derives them — a handset with the wrong clock must not be able to make a late antibiotic
 *      look on time.
 *   2. SCOPE FOLLOWS THE DOMAIN, NOT THE HABIT. The worklist is branch-scoped and the ward name is
 *      part of its key; allergies are hospital-wide and must NOT gain a branch. Both directions
 *      are pinned, because "add the branch everywhere" is the natural mistake and it breaks the
 *      allergy read that prescribing safety depends on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorklistRow, DoseSlot } from "@medicore/api-client";
import { queryKeys } from "../src/query/keys";
import { bedLabel, flagsFor, quietLabel, triageOrder } from "../src/clinical/worklist";
import { doseStateLabel, doseStateTone, summariseSlots } from "../src/clinical/ipd";

const scope = { tenantSlug: "apollo", branchId: "branch-a" };

function row(over: Partial<WorklistRow> = {}): WorklistRow {
  return {
    encounterId: "e1",
    patientId: "p1",
    status: "admitted",
    allergens: [],
    severeAllergy: false,
    dosesDue: 0,
    dosesOverdue: 0,
    ...over,
  };
}

function slot(state: DoseSlot["state"], over: Partial<DoseSlot> = {}): DoseSlot {
  return {
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "DRUG_PARA_500",
    drugName: "Paracetamol 500mg",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: "2026-06-11T12:00:00.000Z",
    state,
    ...over,
  };
}

/* ── 1. the order a ward is walked in ──────────────────────────────────────── */

describe("triage order", () => {
  it("puts overdue first, then due, then bed order", () => {
    const rows = [
      row({ encounterId: "quiet", bedCode: "A-1" }),
      row({ encounterId: "due", bedCode: "A-9", dosesDue: 2 }),
      row({ encounterId: "late", bedCode: "A-20", dosesDue: 3, dosesOverdue: 1 }),
    ];
    expect(triageOrder(rows).map((r) => r.encounterId)).toEqual(["late", "due", "quiet"]);
  });

  it("falls back to bed order NUMERICALLY — A-2 before A-10", () => {
    const rows = [
      row({ encounterId: "ten", ward: "General", bedCode: "A-10" }),
      row({ encounterId: "two", ward: "General", bedCode: "A-2" }),
    ];
    expect(triageOrder(rows).map((r) => r.encounterId)).toEqual(["two", "ten"]);
  });

  it("sorts a patient with no bed recorded last, not first", () => {
    const rows = [row({ encounterId: "nobed" }), row({ encounterId: "bed", bedCode: "A-1" })];
    expect(triageOrder(rows).map((r) => r.encounterId)).toEqual(["bed", "nobed"]);
  });

  /**
   * A severe allergy is something to know before acting, not a task to do now. Promoting it would
   * push a stable patient above somebody whose antibiotic is late.
   */
  it("does not promote a severe allergy above an overdue dose", () => {
    const rows = [
      row({ encounterId: "allergic", allergens: ["penicillins"], severeAllergy: true }),
      row({ encounterId: "late", dosesDue: 1, dosesOverdue: 1 }),
    ];
    expect(triageOrder(rows)[0]?.encounterId).toBe("late");
  });

  it("does not mutate the array it was given", () => {
    const rows = [
      row({ encounterId: "a" }),
      row({ encounterId: "b", dosesOverdue: 1, dosesDue: 1 }),
    ];
    const before = rows.map((r) => r.encounterId);
    triageOrder(rows);
    expect(rows.map((r) => r.encounterId)).toEqual(before);
  });
});

/* ── 2. what the row says ──────────────────────────────────────────────────── */

describe("row flags", () => {
  /**
   * The count that must not double-read. A row with three doses due of which two are late says
   * "2 overdue" and "1 due" — never "2 overdue" and "3 due", which a nurse reads as five.
   */
  it("counts overdue INSIDE due, never beside it", () => {
    const flags = flagsFor(row({ dosesDue: 3, dosesOverdue: 2 }));
    expect(flags.map((f) => f.label)).toEqual(["2 overdue", "1 due"]);
  });

  it("omits the due pill entirely when every outstanding dose is overdue", () => {
    expect(flagsFor(row({ dosesDue: 2, dosesOverdue: 2 })).map((f) => f.label)).toEqual([
      "2 overdue",
    ]);
  });

  /** §17: nothing may be communicated by colour alone. Every pill carries its own word. */
  it("names every state in words, not only in tone", () => {
    const flags = flagsFor(
      row({ dosesDue: 1, dosesOverdue: 1, allergens: ["penicillins"], severeAllergy: true }),
    );
    for (const flag of flags) {
      expect(flag.label.trim().length).toBeGreaterThan(0);
      expect(flag.accessibilityLabel.trim().length).toBeGreaterThan(flag.label.length);
    }
    expect(flags.some((f) => f.label === "Severe allergy")).toBe(true);
  });

  it("distinguishes a severe allergy from an ordinary one in the LABEL", () => {
    expect(flagsFor(row({ allergens: ["latex"] })).map((f) => f.label)).toEqual(["Allergy"]);
    expect(
      flagsFor(row({ allergens: ["latex"], severeAllergy: true })).map((f) => f.label),
    ).toEqual(["Severe allergy"]);
  });

  it("names the allergens for a screen reader rather than just saying 'allergy'", () => {
    const [flag] = flagsFor(row({ allergens: ["penicillins", "latex"] }));
    expect(flag?.accessibilityLabel).toContain("penicillins");
    expect(flag?.accessibilityLabel).toContain("latex");
  });

  it("uses the singular for one dose", () => {
    expect(flagsFor(row({ dosesDue: 1 }))[0]?.accessibilityLabel).toContain(
      "1 medication dose due",
    );
  });

  /**
   * "Nothing due" is stated. A blank row could equally mean "we could not load it", and a nurse
   * skipping a patient on the strength of a blank is the failure that matters.
   */
  it("says 'Nothing due' in words when a patient needs nothing", () => {
    expect(quietLabel(row())).toBe("Nothing due");
    expect(quietLabel(row({ dosesDue: 1 }))).toBeUndefined();
    expect(quietLabel(row({ allergens: ["latex"] }))).toBeUndefined();
  });

  it("says where the patient is, and says so even when it does not know", () => {
    expect(bedLabel(row({ ward: "General", bedCode: "A-1" }))).toBe("General · A-1");
    expect(bedLabel(row({ ward: "General" }))).toBe("General");
    expect(bedLabel(row())).toBe("Bed not recorded");
  });
});

/* ── 3. the phone never derives a clinical state ───────────────────────────── */

describe("dose state comes from the server", () => {
  it("renders whatever state the server sent, including the derived ones", () => {
    expect(doseStateLabel("due")).toBe("Due");
    expect(doseStateLabel("overdue")).toBe("Overdue");
    expect(doseStateLabel("given")).toBe("Given");
    expect(doseStateTone("overdue")).toBe("critical");
  });

  it("summarises with overdue as a SUBSET of due", () => {
    const summary = summariseSlots([slot("due"), slot("overdue"), slot("overdue"), slot("given")]);
    expect(summary).toEqual({ due: 3, overdue: 2, answered: 1 });
  });

  /**
   * ── THE STRUCTURAL CONTROL ────────────────────────────────────────────────
   * A test can only prove that today's code does not compute due-ness. This scan proves the code
   * has no way to: neither the worklist helpers nor the schedule labels may read a clock at all.
   * The moment somebody adds `Date.now()` to decide whether a dose is late, the phone has taken a
   * clinical decision the server owns and this goes red.
   */
  it("no nurse clinical helper reads the device clock", () => {
    const files = ["src/clinical/worklist.ts"];
    for (const file of files) {
      const source = readFileSync(join(__dirname, "..", file), "utf8");
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${file} reads the clock`).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    }
  });

  /**
   * The schedule helpers may not invent `overdue` either — they map a server value to words. If
   * `doseStateLabel` ever starts comparing `scheduledFor` to now, this catches it.
   */
  it("the dose-state helpers map a server value and nothing else", () => {
    const source = readFileSync(join(__dirname, "..", "src/clinical/ipd.ts"), "utf8");
    const helpers = source.slice(source.indexOf("export function doseStateLabel"));
    const code = helpers.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});

/* ── 4. scope follows the domain ───────────────────────────────────────────── */

describe("query keys", () => {
  it("scopes the worklist by branch AND by ward", () => {
    const key = queryKeys.wardWorklist(scope, "limit=40&ward=General");
    expect(key.slice(0, 2)).toEqual(["apollo", "branch-a"]);
    expect(key).toContain("limit=40&ward=General");
  });

  it("gives two wards two cache entries", () => {
    expect(queryKeys.wardWorklist(scope, "ward=General")).not.toEqual(
      queryKeys.wardWorklist(scope, "ward=ICU"),
    );
  });

  it("gives the same ward at two branches two cache entries", () => {
    const other = { tenantSlug: "apollo", branchId: "branch-b" };
    expect(queryKeys.wardWorklist(scope, "ward=ICU")).not.toEqual(
      queryKeys.wardWorklist(other, "ward=ICU"),
    );
  });

  /**
   * The exception that must survive. An allergy is hospital-wide; a branch in this key would
   * re-fetch on every switch and, worse, would claim a distinction the server does not make.
   */
  it("keeps the branch OUT of the allergy key", () => {
    const key = queryKeys.patientAllergies("apollo", "p1");
    expect(key).toEqual(["apollo", "patient", "p1", "allergies"]);
    expect(key).not.toContain("branch-a");
  });

  it("survives a branch switch — the allergy key is identical at both sites", () => {
    expect(queryKeys.patientAllergies("apollo", "p1")).toEqual(
      queryKeys.patientAllergies("apollo", "p1"),
    );
  });

  /**
   * "What is due" and "what was given" are different questions on the same stay. Serving one
   * cache entry for the other would put a record of administration where a to-do list belongs.
   */
  it("never collides the schedule with the administration record", () => {
    expect(queryKeys.medicationSchedule(scope, "e1")).not.toEqual(
      queryKeys.medications(scope, "e1"),
    );
  });

  it("never collides the worklist with the plain inpatient list", () => {
    expect(queryKeys.wardWorklist(scope, "")).not.toEqual(queryKeys.inpatients(scope, ""));
  });
});

/* ── 5. the worklist stays one request per page ────────────────────────────── */

describe("the worklist does not fan out per patient", () => {
  /**
   * ── THE N+1 CONTROL ───────────────────────────────────────────────────────
   * The whole reason `GET /ward-worklist` exists. The same screen could be assembled from
   * `/inpatients` plus a per-patient allergy call plus a per-encounter schedule call — sixty-one
   * requests for a twenty-bed ward, on hospital wifi, before the nurse touches anything.
   *
   * A runtime assertion would need a rendered list; this is provable structurally and cannot rot:
   * the worklist screen may not reach for a PER-PATIENT or PER-ENCOUNTER query at all. Those
   * belong on the chart, where there is exactly one patient.
   */
  const screen = readFileSync(join(__dirname, "..", "app/(app)/ward.tsx"), "utf8");
  const code = screen.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const perPatient = [
    "queries.allergies(",
    "queries.medicationSchedule(",
    "queries.medications(",
    "queries.patient(",
    "queries.encounter(",
    "queries.encounterVitals(",
  ];

  for (const call of perPatient) {
    it(`does not call ${call}…) from the list`, () => {
      expect(code).not.toContain(call);
    });
  }

  it("reads the worklist and the bed board, and nothing else clinical", () => {
    expect(code).toContain("queries.wardWorklist(");
    expect(code).toContain("queries.bedBoard(");
  });

  /** Pagination must actually be wired, or the first page silently becomes the whole ward. */
  it("fetches the next page rather than truncating at the first", () => {
    expect(code).toContain("hasNextPage");
    expect(code).toContain("fetchNextPage");
  });
});
