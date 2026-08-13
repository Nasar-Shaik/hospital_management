/**
 * The medication round as an ordering and a set of labels (W4) — the decisions, in Node.
 *
 * The screen is tested next door in `medicationRound.test.tsx` against a real `ApiClient`. What is
 * tested HERE is what can be decided without a browser: the order a nurse walks the ward in, the
 * words on a row, and — the guards at the bottom — the two boundaries this file must never cross.
 */
import { describe, it, expect } from "vitest";
import type { DoseSlot, MedicationRoundRow } from "@medicore/api-client";
import {
  bedLabel,
  doseStateLabel,
  earliestOutstanding,
  partialOrderNotice,
  quietLabel,
  roundFlags,
  roundOrder,
  slotKey,
  slotOrder,
  summariseRound,
  summaryLabel,
  wardOptions,
} from "../lib/round";

function slot(over: Partial<DoseSlot> = {}): DoseSlot {
  return {
    prescriptionId: "rx1",
    lineIndex: 0,
    drugCode: "PARA500",
    drugName: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    frequency: "TDS",
    scheduledFor: "2026-08-13T08:00:00.000Z",
    state: "due",
    ...over,
  };
}

function row(over: Partial<MedicationRoundRow> = {}): MedicationRoundRow {
  const slots = over.slots ?? [slot()];
  const outstanding = slots.filter((s) => s.state === "due" || s.state === "overdue");
  return {
    encounterId: "e1",
    patientId: "p1",
    patientName: "Asha Rao",
    uhid: "UH-1001",
    ward: "General",
    bedCode: "A-1",
    allergens: [],
    severeAllergy: false,
    dosesDue: outstanding.length,
    dosesOverdue: outstanding.filter((s) => s.state === "overdue").length,
    ...over,
    slots,
  };
}

describe("1. the order a nurse walks the ward in", () => {
  it("puts the earliest outstanding dose first, which puts overdue before due", () => {
    const late = row({
      encounterId: "late",
      bedCode: "A-9",
      slots: [slot({ scheduledFor: "2026-08-13T06:00:00.000Z", state: "overdue" })],
    });
    const soon = row({
      encounterId: "soon",
      bedCode: "A-1",
      slots: [slot({ scheduledFor: "2026-08-13T10:00:00.000Z", state: "due" })],
    });

    // Bed order would put A-1 first and find the late dose in A-9 eight beds too late.
    expect(roundOrder([soon, late]).map((r) => r.encounterId)).toEqual(["late", "soon"]);
  });

  it("sinks patients with nothing outstanding to the bottom, in bed order", () => {
    const quiet1 = row({ encounterId: "q9", bedCode: "A-9", slots: [slot({ state: "given" })] });
    const quiet2 = row({ encounterId: "q2", bedCode: "A-2", slots: [slot({ state: "given" })] });
    const busy = row({ encounterId: "busy", bedCode: "Z-1" });

    expect(roundOrder([quiet1, quiet2, busy]).map((r) => r.encounterId)).toEqual([
      "busy",
      "q2",
      "q9",
    ]);
  });

  it("orders beds naturally — A-2 before A-10, not after it", () => {
    const a10 = row({ encounterId: "a10", bedCode: "A-10", slots: [slot({ state: "given" })] });
    const a2 = row({ encounterId: "a2", bedCode: "A-2", slots: [slot({ state: "given" })] });
    expect(roundOrder([a10, a2]).map((r) => r.encounterId)).toEqual(["a2", "a10"]);
  });

  /**
   * A severe allergy is not a task. Promoting it would push a stable patient above a late dose,
   * which is a clinical priority this screen has no business inventing.
   */
  it("does NOT promote a severe allergy above an outstanding dose", () => {
    const allergic = row({
      encounterId: "allergic",
      bedCode: "A-9",
      allergens: ["PENICILLIN"],
      severeAllergy: true,
      slots: [slot({ state: "given" })],
    });
    const due = row({ encounterId: "due", bedCode: "A-1" });
    expect(roundOrder([allergic, due]).map((r) => r.encounterId)).toEqual(["due", "allergic"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [row({ encounterId: "b", bedCode: "A-9" }), row({ encounterId: "a" })];
    const before = rows.map((r) => r.encounterId);
    roundOrder(rows);
    expect(rows.map((r) => r.encounterId)).toEqual(before);
  });

  it("reads the earliest OUTSTANDING dose, ignoring answered ones that fall earlier", () => {
    const r = row({
      slots: [
        slot({ scheduledFor: "2026-08-13T06:00:00.000Z", state: "given" }),
        slot({ scheduledFor: "2026-08-13T12:00:00.000Z", state: "due" }),
      ],
    });
    expect(earliestOutstanding(r)).toBe("2026-08-13T12:00:00.000Z");
  });

  it("works a patient's own doses earliest first, with a stable tie-break", () => {
    const ordered = slotOrder([
      slot({ drugName: "Zinc", scheduledFor: "2026-08-13T08:00:00.000Z" }),
      slot({ drugName: "Aspirin", scheduledFor: "2026-08-13T08:00:00.000Z" }),
      slot({ drugName: "Morphine", scheduledFor: "2026-08-13T06:00:00.000Z" }),
    ]);
    expect(ordered.map((s) => s.drugName)).toEqual(["Morphine", "Aspirin", "Zinc"]);
  });

  it("keys a dose by its full identity, so two doses of one drug never collide", () => {
    const eight = slot({ scheduledFor: "2026-08-13T08:00:00.000Z" });
    const two = slot({ scheduledFor: "2026-08-13T14:00:00.000Z" });
    expect(slotKey(eight)).not.toBe(slotKey(two));
    expect(slotKey(eight)).toContain("rx1");
    expect(slotKey(eight)).toContain("2026-08-13T08:00:00.000Z");
  });
});

describe("2. the words on a row", () => {
  it("counts overdue and still-due separately, never double-counting", () => {
    const flags = roundFlags(row({ dosesDue: 3, dosesOverdue: 2, slots: [slot()] }));
    expect(flags.map((f) => f.label)).toEqual(["2 overdue", "1 due"]);
  });

  it("gives every pill a spoken label, so colour is never the only carrier", () => {
    const flags = roundFlags(
      row({ dosesDue: 1, dosesOverdue: 1, allergens: ["PENICILLIN"], severeAllergy: true }),
    );
    for (const flag of flags) {
      expect(flag.accessibilityLabel.length).toBeGreaterThan(flag.label.length);
    }
    expect(flags.some((f) => f.accessibilityLabel.includes("PENICILLIN"))).toBe(true);
  });

  it("distinguishes 'no doses today' from 'all answered' from 'still outstanding'", () => {
    expect(quietLabel(row({ slots: [] }))).toBe("No scheduled doses today");
    expect(quietLabel(row({ slots: [slot({ state: "given" })] }))).toBe("All doses answered");
    expect(quietLabel(row())).toBeUndefined();
  });

  it("names the bed as context, and says so when there is none", () => {
    expect(bedLabel({ ward: "ICU", bedCode: "3" })).toBe("ICU · 3");
    expect(bedLabel({ ward: "ICU" })).toBe("ICU");
    expect(bedLabel({})).toBe("Bed not recorded");
  });

  it("translates each server state without re-deriving any of them", () => {
    expect(doseStateLabel({ state: "overdue" })).toEqual({ text: "Overdue", tone: "critical" });
    expect(doseStateLabel({ state: "due" })).toEqual({ text: "Due", tone: "warning" });
    expect(doseStateLabel({ state: "given" })).toEqual({ text: "Given", tone: "success" });
    expect(doseStateLabel({ state: "held" }).text).toBe("Held");
    expect(doseStateLabel({ state: "refused" }).text).toBe("Refused");
    expect(doseStateLabel({ state: "not_available" }).text).toBe("Not available");
  });
});

describe("3. the summary is honest about how much it can see", () => {
  it("adds up the SERVER's counts across loaded rows", () => {
    const summary = summariseRound(
      [row({ dosesDue: 2, dosesOverdue: 1 }), row({ dosesDue: 1 })],
      2,
    );
    expect(summary).toMatchObject({ patients: 2, due: 3, overdue: 1, complete: true });
  });

  /**
   * The server pages the round in BED order and says so; the urgency sort is applied over what is
   * in the browser. A nurse reading "2 doses due" off page one of three and stopping is the exact
   * failure these two functions exist to prevent.
   */
  it("says the round is incomplete when more pages remain", () => {
    const summary = summariseRound([row()], 40);
    expect(summary.complete).toBe(false);
    expect(summaryLabel(summary)).toContain("of more patients loaded");
    expect(partialOrderNotice(summary)).toMatch(/loaded so far/i);
  });

  it("says nothing about ordering once everything is loaded", () => {
    expect(partialOrderNotice(summariseRound([row()], 1))).toBeUndefined();
  });

  it("does not claim 'nothing outstanding' for a partially loaded ward", () => {
    const label = summaryLabel(summariseRound([row({ dosesDue: 0, dosesOverdue: 0 })], 40));
    expect(label).toContain("Nothing outstanding yet");
  });

  it("pluralises so a round never reads '1 doses'", () => {
    expect(summaryLabel(summariseRound([row({ dosesDue: 1, dosesOverdue: 0 })], 1))).toContain(
      "1 dose outstanding",
    );
  });
});

describe("4. ward options come from the round, not a catalogue", () => {
  it("offers the wards patients are actually in, sorted and de-duplicated", () => {
    const rows = [
      row({ encounterId: "1", ward: "ICU" }),
      row({ encounterId: "2", ward: "General" }),
      row({ encounterId: "3", ward: "ICU" }),
      row({ encounterId: "4", ward: undefined }),
    ];
    expect(wardOptions(rows)).toEqual(["General", "ICU"]);
  });
});

/* ── guards: the two boundaries this file must never cross ─────────────────── */

function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function readSource(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return codeOf(await readFile(join(process.cwd(), relative), "utf8"));
}

describe("5. what the round may not contain", () => {
  it("reads no clock — due and overdue are the server's, never re-derived", async () => {
    for (const file of ["lib/round.ts", "app/medication-round/page.tsx"]) {
      const source = await readSource(file);
      expect(source).not.toMatch(/Date\.now\(\)/);
      expect(source).not.toMatch(/new Date\(\)/);
      expect(source).not.toMatch(/toLocaleTimeString|toLocaleDateString|toLocaleString/);
    }
  });

  /**
   * Every dose-state word this file mentions is one the SERVER produces.
   *
   * Mobile's equivalent guard asserts the exact pair `["due", "overdue"]`, because its round
   * re-implements the open-state predicate locally. This one cannot: it imports `isSlotOpen` from
   * the client package and maps the six states with a `switch`, so the assertion is instead that
   * the vocabulary is a SUBSET of the server's — a `state === "late"` or a `state === "missed"`
   * would be this screen inventing a clinical category, and that is what must stay impossible.
   */
  it("speaks only the server's state words", async () => {
    const source = await readSource("lib/round.ts");
    const mentioned = [
      ...[...source.matchAll(/state\s*===\s*["'](\w+)["']/g)].map((m) => m[1]),
      ...[...source.matchAll(/case\s+["'](\w+)["']:/g)].map((m) => m[1]),
    ];
    expect(mentioned.length).toBeGreaterThan(0);
    const server = ["due", "overdue", "given", "held", "refused", "not_available"];
    expect(mentioned.filter((s) => !server.includes(s as string))).toEqual([]);
  });

  /**
   * And it never compares a scheduled time to anything but another scheduled time.
   *
   * `scheduledFor.localeCompare(other.scheduledFor)` is sorting — two server instants against each
   * other, no clock involved. `scheduledFor < Date.now()` would be the round deciding lateness from
   * the reader's machine, which is exactly the defect W2 removed from six other screens.
   */
  it("never measures a scheduled time against a clock", async () => {
    for (const file of ["lib/round.ts", "app/medication-round/page.tsx"]) {
      const source = await readSource(file);
      expect(source).not.toMatch(/scheduledFor\s*[<>]=?\s*(?!.*scheduledFor)/);
      expect(source).not.toMatch(/getTime\(\)|valueOf\(\)|\+\s*86_?400/);
    }
  });

  /**
   * THE MANDATORY ONE. The round is a navigator; there is exactly one administration path and it
   * is W3's. A write from this file would be a second medication administration system.
   */
  it("never writes — no administration call anywhere in the round", async () => {
    for (const file of ["lib/round.ts", "app/medication-round/page.tsx"]) {
      const source = await readSource(file);
      expect(source).not.toMatch(/recordMedicationAdministration/);
      expect(source).not.toMatch(/attemptDose|attemptAdministration/);
      expect(source).not.toMatch(/idempotencyKey|keyFor\(/);
    }
  });

  it("builds no slot identity of its own — it uses the client package's constructor", async () => {
    const source = await readSource("app/medication-round/page.tsx");
    expect(source).toMatch(/slotRef\(/);
    // A hand-rolled literal is how a surface quietly starts sending the wrong three fields.
    expect(source).not.toMatch(/prescriptionId:\s*slot\.prescriptionId/);
  });
});
