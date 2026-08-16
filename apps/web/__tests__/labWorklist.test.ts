/**
 * W-2 — THE LAB WORKLIST IS A LIST OF PEOPLE, AND A REPORT LIST IS A LIST OF TESTS.
 *
 * ── THE TWO DEFECTS THIS CLOSES ─────────────────────────────────────────────
 * Both came out of the same manual-testing session, and both are the same mistake made twice:
 * showing the database's row shape instead of the clinical unit of work.
 *
 *  1. The technician's worklist listed every outstanding ORDER in the department in one flat list.
 *     One patient with four tests appeared as four rows scattered among everybody else's, so the
 *     same person had to be re-found four times and there was no way to see whose sample was whose.
 *
 *  2. The doctor's report list drew one row per FILE, with the test name repeated on each. Three
 *     of four tests had been uploaded twice — 51 s and 103 s apart, measured from the tenant
 *     database — so four completed orders rendered as seven results and looked like duplicated
 *     work rather than one test with a re-scan attached.
 *
 * ── WHY THIS IS A NODE TEST AND NOT A RENDER ────────────────────────────────
 * Both fixes are grouping decisions, which is the part that can be wrong. Per this app's house
 * rule the decision lives outside the component (`lib/worklist.ts`, `lib/reports.ts`) and is
 * proven here without a DOM. What a Node test CANNOT prove is that the page actually calls them —
 * so the last block reads the page sources and pins the wiring, because a helper nothing imports
 * is the exact shape of the `LicenceNotice` mistake this repository has already made once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrderRow, ReportMeta } from "@medicore/api-client";
import { groupByPatient, waited } from "../lib/worklist";
import { groupReportsByOrder } from "../lib/reports";

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "o1",
    patientId: "p1",
    patientName: "Asha Rao",
    uhid: "UH-001",
    encounterId: "e1",
    episodeId: "ep1",
    category: "lab",
    code: "CBC",
    name: "Complete Blood Count",
    priority: "routine",
    status: "placed",
    orderedBy: "doc-1",
    orderedAt: "2026-08-16T09:00:00.000Z",
    ...over,
  } as OrderRow;
}

function report(over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    id: "r1",
    orderId: "o1",
    encounterId: "e1",
    patientId: "p1",
    episodeId: "ep1",
    category: "lab",
    testName: "Complete Blood Count",
    visitDate: "2026-08-16T09:00:00.000Z",
    filename: "labTechsign.png",
    contentType: "image/png",
    size: 4959,
    uploadedBy: "tech-1",
    uploadedAt: "2026-08-16T19:12:07.246Z",
    ...over,
  };
}

const read = (relative: string): string =>
  readFileSync(join(__dirname, "..", relative), "utf8").toString();

describe("the worklist groups by patient", () => {
  it("collapses one person's four tests into a single queue row", () => {
    const groups = groupByPatient([
      order({ id: "o1", name: "Blood Glucose (Fasting)" }),
      order({ id: "o2", name: "Complete Blood Count" }),
      order({ id: "o3", name: "Liver Function Test" }),
      order({ id: "o4", name: "Urine Routine Examination" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.patientName).toBe("Asha Rao");
    expect(groups[0]?.orders.map((o) => o.name)).toEqual([
      "Blood Glucose (Fasting)",
      "Complete Blood Count",
      "Liver Function Test",
      "Urine Routine Examination",
    ]);
  });

  it("keeps two patients apart even when they ordered the same test", () => {
    const groups = groupByPatient([
      order({ id: "o1", patientId: "p1", patientName: "Asha Rao", uhid: "UH-001" }),
      order({ id: "o2", patientId: "p2", patientName: "Bikram Sen", uhid: "UH-002" }),
    ]);

    expect(groups.map((g) => g.patientId)).toEqual(["p1", "p2"]);
    expect(groups.every((g) => g.orders.length === 1)).toBe(true);
  });

  it("interleaved rows still land in the right person's group", () => {
    // The server sorts by priority then age, so one patient's rows are NOT contiguous.
    const groups = groupByPatient([
      order({ id: "a1", patientId: "p1" }),
      order({ id: "b1", patientId: "p2", patientName: "Bikram Sen" }),
      order({ id: "a2", patientId: "p1" }),
      order({ id: "b2", patientId: "p2", patientName: "Bikram Sen" }),
      order({ id: "a3", patientId: "p1" }),
    ]);

    expect(groups.map((g) => g.orders.length)).toEqual([3, 2]);
    expect(groups[0]?.orders.map((o) => o.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("preserves the server's triage order rather than re-sorting it", () => {
    /**
     * Emergency-first is the SERVER's decision; grouping must not undo it and must not invent a
     * second sort of its own — first appearance is the whole rule. The names and the UHIDs are
     * chosen to CONTRADICT every plausible wrong sort: alphabetically Zara comes last, by UHID
     * she comes last, and by arrival she is first because she is the emergency. A fixture whose
     * names happened to sort the right way would pass this test while the rule was broken — which
     * is exactly what an earlier draft of it did.
     */
    const groups = groupByPatient([
      order({
        id: "e1",
        patientId: "p9",
        patientName: "Zara Qureshi",
        uhid: "UH-900",
        priority: "emergency",
        orderedAt: "2026-08-16T11:55:00.000Z",
      }),
      order({
        id: "r1",
        patientId: "p1",
        patientName: "Anil Bose",
        uhid: "UH-001",
        priority: "routine",
        orderedAt: "2026-08-16T07:00:00.000Z",
      }),
    ]);

    expect(groups.map((g) => g.patientName)).toEqual(["Zara Qureshi", "Anil Bose"]);
  });

  it("wears the most urgent priority in the group, not the first one seen", () => {
    const groups = groupByPatient([
      order({ id: "o1", priority: "routine" }),
      order({ id: "o2", priority: "stat" }),
      order({ id: "o3", priority: "urgent" }),
    ]);

    expect(groups[0]?.topPriority).toBe("stat");
  });

  it("an unknown priority never displaces a real one", () => {
    const groups = groupByPatient([
      order({ id: "o1", priority: "urgent" }),
      order({ id: "o2", priority: "whenever" as OrderPriorityLike }),
    ]);

    expect(groups[0]?.topPriority).toBe("urgent");
  });

  it("counts the wait from the OLDEST order, whichever position it arrived in", () => {
    const groups = groupByPatient([
      order({ id: "o1", orderedAt: "2026-08-16T11:00:00.000Z" }),
      order({ id: "o2", orderedAt: "2026-08-16T07:30:00.000Z" }),
      order({ id: "o3", orderedAt: "2026-08-16T09:00:00.000Z" }),
    ]);

    expect(groups[0]?.waitingSince).toBe("2026-08-16T07:30:00.000Z");
  });

  it("an empty queue is an empty list, not a group of nobody", () => {
    expect(groupByPatient([])).toEqual([]);
  });
});

describe("how long a patient has been waiting", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");

  it("reads in minutes under the hour", () => {
    expect(waited("2026-08-16T11:35:00.000Z", now)).toBe("25 min");
  });

  it("reads in hours past it", () => {
    expect(waited("2026-08-16T09:00:00.000Z", now)).toBe("3 h");
  });

  it("reads in days past two", () => {
    expect(waited("2026-08-13T12:00:00.000Z", now)).toBe("3 d");
  });

  it("a clock skew that puts the order in the future shows zero, never a negative age", () => {
    expect(waited("2026-08-16T12:30:00.000Z", now)).toBe("0 min");
  });
});

describe("the doctor's report list groups by test", () => {
  it("two uploads against one order are ONE test with two files", () => {
    // The exact shape found in the tenant database: same order, same test, 103 seconds apart.
    const groups = groupReportsByOrder([
      report({ id: "r-first", uploadedAt: "2026-08-16T19:12:07.246Z" }),
      report({ id: "r-second", uploadedAt: "2026-08-16T19:13:50.063Z" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.testName).toBe("Complete Blood Count");
    expect(groups[0]?.files).toHaveLength(2);
  });

  it("the four ordered tests read as four rows, not seven", () => {
    // Precisely the reported case: four orders, three of them uploaded twice.
    const groups = groupReportsByOrder([
      report({ id: "r1", orderId: "o-bg", testName: "Blood Glucose (Fasting)" }),
      report({ id: "r2", orderId: "o-cbc", testName: "Complete Blood Count" }),
      report({ id: "r3", orderId: "o-lft", testName: "Liver Function Test" }),
      report({ id: "r4", orderId: "o-ure", testName: "Urine Routine Examination" }),
      report({ id: "r5", orderId: "o-bg", testName: "Blood Glucose (Fasting)" }),
      report({ id: "r6", orderId: "o-cbc", testName: "Complete Blood Count" }),
      report({ id: "r7", orderId: "o-lft", testName: "Liver Function Test" }),
    ]);

    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.files.length)).toEqual([2, 2, 2, 1]);
  });

  it("shows the NEWEST upload first — the correction is the one that came second", () => {
    const groups = groupReportsByOrder([
      report({ id: "r-old", uploadedAt: "2026-08-16T19:12:07.246Z" }),
      report({ id: "r-new", uploadedAt: "2026-08-16T19:13:50.063Z" }),
    ]);

    expect(groups[0]?.files.map((f) => f.id)).toEqual(["r-new", "r-old"]);
  });

  it("keeps every file — nothing is hidden, because the browser cannot know which is right", () => {
    const groups = groupReportsByOrder([
      report({ id: "r-old", filename: "blurred.png" }),
      report({ id: "r-new", filename: "rescan.png", uploadedAt: "2026-08-16T19:20:00.000Z" }),
    ]);

    expect(groups[0]?.files.map((f) => f.filename)).toEqual(["rescan.png", "blurred.png"]);
  });

  it("different orders stay separate even when the test name is identical", () => {
    // A CBC repeated the next morning is a second test, not a second file.
    const groups = groupReportsByOrder([
      report({ id: "r1", orderId: "o-mon", visitDate: "2026-08-15T09:00:00.000Z" }),
      report({ id: "r2", orderId: "o-tue", visitDate: "2026-08-16T09:00:00.000Z" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("no reports is no groups", () => {
    expect(groupReportsByOrder([])).toEqual([]);
  });
});

/**
 * ── THE HELPERS HAVE TO BE REACHED, NOT MERELY CORRECT ──────────────────────
 * A grouping function nothing imports is the `LicenceNotice` mistake in a different file. These
 * assertions fail if the page reverts to rendering the flat list, which is the regression that
 * actually matters.
 */
describe("the pages consume the grouping rather than re-listing rows", () => {
  const WORKLIST = read("app/worklist/page.tsx");
  const MY_PATIENTS = read("app/my-patients/page.tsx");

  it("the worklist imports and calls groupByPatient", () => {
    expect(WORKLIST).toMatch(/from "\.\.\/\.\.\/lib\/worklist"/);
    expect(WORKLIST).toMatch(/groupByPatient\(orders\)/);
  });

  it("the worklist renders a queue of patients, keyed by patient", () => {
    expect(WORKLIST).toMatch(/groups\.map\(\(g\) =>/);
    expect(WORKLIST).toMatch(/key=\{g\.patientId\}/);
  });

  it("the report list groups by order before drawing a row", () => {
    expect(MY_PATIENTS).toMatch(/from "\.\.\/\.\.\/lib\/reports"/);
    expect(MY_PATIENTS).toMatch(/groupReportsByOrder\(catReports\)/);
    // One <li> per ORDER. Keying on the file id again would be the old behaviour restored.
    expect(MY_PATIENTS).toMatch(/key=\{g\.orderId\}/);
  });

  it("the worklist shows what is already attached to an order", () => {
    // The uploads happened twice because nothing on screen said the first one had landed.
    expect(WORKLIST).toMatch(/reports? attached/);
    expect(WORKLIST).toMatch(/Upload another/);
  });
});

/** Only used to build an order whose priority this build has never heard of. */
type OrderPriorityLike = OrderRow["priority"];
